// Spike S3(a): a 0-SOL burner wallet swaps through a sponsor route that runs the production
// validator (packages/api/src/sponsor), co-signs, simulates and sends. Transactions that break
// the allowlist must be refused before anything is signed.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DEFAULT_SPONSOR_LIMITS,
  type SponsorPolicy,
  validateSponsoredTransaction,
} from '@horagon/api/sponsor'
import { PmAmmClient } from '@horagon/pm-amm-vendor'
import {
  DEVNET_MUSDC_MINT,
  deriveNoMint,
  deriveYesMint,
  PM_AMM_PROGRAM_ID,
  PROTOCOL_DAO,
} from '@horagon/sdk/pm-amm'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { tokenBalance, txStats, waitForSignature } from './lib/chain'
import { connect } from './lib/env'
import { pmAmmClient } from './lib/pmamm'
import { runSpike, SpikeRun } from './lib/results'
import { loadOrCreateKeypair } from './lib/wallet'

const MAX_BODY_BYTES = 8 * 1024
const run = new SpikeRun('s3a-sponsor', 'devnet')

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/** POST /tx/submit {tx: base64 v0 transaction signed by the user} -> {signature} | 4xx. */
function sponsorRoute(connection: Connection, sponsor: Keypair, policy: SponsorPolicy) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== 'POST' || req.url !== '/tx/submit')
        return reply(res, 404, { code: 'NOT_FOUND' })
      const { tx: b64 } = JSON.parse(await readBody(req)) as { tx?: unknown }
      if (typeof b64 !== 'string') return reply(res, 400, { code: 'INVALID_INPUT' })
      const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
      const verdict = validateSponsoredTransaction(tx, policy)
      if (!verdict.ok) {
        return reply(res, 400, {
          code: 'SPONSOR_REJECTED',
          reason: verdict.reason,
          detail: verdict.detail,
        })
      }
      tx.sign([sponsor])
      const sim = await connection.simulateTransaction(tx, {
        sigVerify: true,
        commitment: 'confirmed',
      })
      if (sim.value.err) {
        return reply(res, 400, {
          code: 'SIMULATION_FAILED',
          err: sim.value.err,
          logs: sim.value.logs,
        })
      }
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true })
      await waitForSignature(connection, signature)
      return reply(res, 200, { signature })
    } catch (e) {
      return reply(res, 500, { code: 'INTERNAL', message: String(e) })
    }
  }
}

async function submit(base: string, tx: VersionedTransaction) {
  const res = await fetch(`${base}/tx/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: Buffer.from(tx.serialize()).toString('base64') }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function userSignedTx(
  connection: Connection,
  sponsor: PublicKey,
  user: Keypair,
  instructions: TransactionInstruction[],
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: sponsor,
    recentBlockhash: blockhash,
    instructions,
  })
  const tx = new VersionedTransaction(message.compileToV0Message())
  tx.sign([user])
  return tx
}

await runSpike(run, async () => {
  const connection = await connect('devnet')
  const creator = loadOrCreateKeypair('creator')
  const funder = loadOrCreateKeypair('trader')
  const sponsor = loadOrCreateKeypair('sponsor')
  const burner = Keypair.generate()

  // The sponsor holds only SOL. Top it up from the creator if it is low.
  if ((await connection.getBalance(sponsor.publicKey)) < 0.03 * LAMPORTS_PER_SOL) {
    const top = await userSignedTx(connection, creator.publicKey, creator, [
      SystemProgram.transfer({
        fromPubkey: creator.publicKey,
        toPubkey: sponsor.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      }),
    ])
    await waitForSignature(connection, await connection.sendTransaction(top))
  }

  // A short market the policy treats as Horagon's.
  const created = await pmAmmClient(connection, creator).send.createMarket({
    name: 'HRG SPIKE S3A',
    durationSecs: 900,
    initialPriceBps: 5000,
    depositUsdc: 100,
  })
  const market = new PublicKey(created.marketPda)
  const yesMint = deriveYesMint(market)
  const noMint = deriveNoMint(market)
  run.record('market', market.toBase58())

  // The funder gives the burner 20 mUSDC (and pays that ATA's rent): the burner has 0 SOL.
  const burnerUsdc = getAssociatedTokenAddressSync(DEVNET_MUSDC_MINT, burner.publicKey)
  const fund = await userSignedTx(connection, funder.publicKey, funder, [
    createAssociatedTokenAccountIdempotentInstruction(
      funder.publicKey,
      burnerUsdc,
      burner.publicKey,
      DEVNET_MUSDC_MINT,
    ),
    createTransferInstruction(
      getAssociatedTokenAddressSync(DEVNET_MUSDC_MINT, funder.publicKey),
      burnerUsdc,
      funder.publicKey,
      20_000_000n,
    ),
  ])
  await waitForSignature(connection, await connection.sendTransaction(fund))
  run.check('burner starts with 0 SOL', (await connection.getBalance(burner.publicKey)) === 0)

  const policy: SponsorPolicy = {
    sponsor: sponsor.publicKey,
    collateralMint: DEVNET_MUSDC_MINT,
    feeOwners: [PROTOCOL_DAO, creator.publicKey],
    isHoragonMarket: (m) => m.equals(market),
    isOutcomeMint: (m) => m.equals(yesMint) || m.equals(noMint),
    limits: DEFAULT_SPONSOR_LIMITS,
  }
  const server = createServer(sponsorRoute(connection, sponsor, policy))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    const reader = PmAmmClient.readOnly(connection, PM_AMM_PROGRAM_ID, DEVNET_MUSDC_MINT)
    const ata = (owner: PublicKey, mint: PublicKey) =>
      createAssociatedTokenAccountIdempotentInstruction(
        sponsor.publicKey,
        getAssociatedTokenAddressSync(mint, owner, true),
        owner,
        mint,
      )
    const swap = await reader.ix.swap({
      signer: burner.publicKey,
      market,
      direction: 'usdcToYes',
      amountIn: 10_000_000,
      minOutput: 0,
      creatorAuthority: creator.publicKey,
      collateralMint: DEVNET_MUSDC_MINT,
    })
    const good = await userSignedTx(connection, sponsor.publicKey, burner, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ata(burner.publicKey, yesMint),
      ata(burner.publicKey, noMint),
      ata(PROTOCOL_DAO, DEVNET_MUSDC_MINT),
      ata(creator.publicKey, DEVNET_MUSDC_MINT),
      swap,
    ])
    const sponsorBefore = await connection.getBalance(sponsor.publicKey)
    const accepted = await submit(base, good)
    run.record('sponsoredSwap', accepted)
    if (
      run.check(
        'sponsored burner swap confirmed',
        accepted.status === 200,
        JSON.stringify(accepted.body),
      )
    ) {
      const { stats } = await txStats(connection, String(accepted.body.signature))
      run.record('sponsoredSwapStats', stats)
      run.check('burner still has 0 SOL', (await connection.getBalance(burner.publicKey)) === 0)
      const yes = await tokenBalance(connection, burner.publicKey, yesMint)
      run.check('burner received YES', yes > 0n, `${yes} YES`)
      run.record(
        'sponsorCostLamports',
        sponsorBefore - (await connection.getBalance(sponsor.publicKey)),
      )
    }

    const deposit = await reader.ix.depositLiquidity({
      signer: burner.publicKey,
      market,
      amount: 1_000_000,
      collateralMint: DEVNET_MUSDC_MINT,
    })
    const bad: Array<[string, TransactionInstruction[], string]> = [
      [
        'SOL transfer out of the sponsor',
        [
          SystemProgram.transfer({
            fromPubkey: sponsor.publicKey,
            toPubkey: burner.publicKey,
            lamports: 1,
          }),
          swap,
        ],
        'SPONSOR_MISUSE',
      ],
      ['deposit_liquidity', [deposit], 'PM_AMM_RULE'],
      [
        'ATA for a stranger',
        [ata(Keypair.generate().publicKey, DEVNET_MUSDC_MINT), swap],
        'ATA_RULE',
      ],
      [
        'CU limit above the cap',
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), swap],
        'COMPUTE_BUDGET',
      ],
    ]
    for (const [label, ixs, reason] of bad) {
      const refused = await submit(
        base,
        await userSignedTx(connection, sponsor.publicKey, burner, ixs),
      )
      run.check(
        `route refuses: ${label}`,
        refused.status === 400 && refused.body.reason === reason,
        `${refused.status} ${String(refused.body.reason)}`,
      )
    }
  } finally {
    server.close()
  }
})
