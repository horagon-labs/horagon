// Spike S2 driver: exercises spikes/s2-cpi (program `horagon_spike`) on Surfpool
// (`--cluster local`, default) or devnet. Pass: the Authority PDA creates, seeds and resolves
// a pm-AMM market through CPI; invoke depth <= 5; the create transaction fits in 1,232 bytes.
import { createHash, getRandomValues } from 'node:crypto'
import { join } from 'node:path'
import {
  DEVNET_MUSDC_MINT,
  decodeMarket,
  deriveLpPosition,
  deriveMarketPda,
  deriveNoMint,
  deriveVault,
  deriveYesMint,
  extractProgramErrorCode,
  METAPLEX_PROGRAM_ID,
  PM_AMM_PROGRAM_ID,
} from '@horagon/sdk/pm-amm'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { chainUnixTime, tokenDelta, txStats, waitForChainTime, waitForSignature } from './lib/chain'
import { clusterArg, connect, rpcUrl } from './lib/env'
import { pmAmmClient } from './lib/pmamm'
import { runSpike, SpikeRun } from './lib/results'
import { surfnetTimeTravel } from './lib/surfnet'
import { loadKeypair, loadOrCreateKeypair } from './lib/wallet'

const PROGRAM_KEYPAIR = join(
  import.meta.dirname,
  '../s2-cpi/target/deploy/horagon_spike-keypair.json',
)
const MAX_TX_BYTES = 1232
const cluster = clusterArg('local')
const run = new SpikeRun('s2-cpi', cluster)

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

function i64(n: bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigInt64LE(n)
  return b
}

function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(bytes.length)
  return Buffer.concat([len, bytes])
}

const metadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID,
  )[0]

async function send(connection: Connection, payer: Keypair, ixs: TransactionInstruction[]) {
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  })
  const tx = new VersionedTransaction(message.compileToV0Message())
  tx.sign([payer])
  return tx
}

await runSpike(run, async () => {
  const connection = await connect(cluster)
  const programId = loadKeypair(PROGRAM_KEYPAIR).publicKey
  run.record('programId', programId.toBase58())
  run.check(
    'horagon_spike is deployed',
    (await connection.getAccountInfo(programId))?.executable === true,
  )

  const payer = loadOrCreateKeypair(cluster === 'devnet' ? 'creator' : 'deployer')
  if (
    cluster === 'local' &&
    (await connection.getBalance(payer.publicKey)) < 5 * LAMPORTS_PER_SOL
  ) {
    await waitForSignature(
      connection,
      await connection.requestAirdrop(payer.publicKey, 20 * LAMPORTS_PER_SOL),
    )
  }
  const advanceTo = (t: number) =>
    cluster === 'local'
      ? surfnetTimeTravel(rpcUrl('local'), connection, t)
      : waitForChainTime(connection, t)

  // Collateral: a local mint on Surfpool; mUSDC from the creator wallet on devnet.
  let mint = DEVNET_MUSDC_MINT
  if (cluster === 'local') {
    mint = await createMint(connection, payer, payer.publicKey, null, 6)
    const own = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey)
    await mintTo(connection, payer, mint, own.address, payer, 1_000_000_000n)
  }

  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('authority')], programId)
  const treasury = getAssociatedTokenAddressSync(mint, authority, true)
  const fund = await send(connection, payer, [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: authority,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treasury, authority, mint),
    createTransferInstruction(
      getAssociatedTokenAddressSync(mint, payer.publicKey),
      treasury,
      payer.publicKey,
      150_000_000n,
    ),
  ])
  await waitForSignature(connection, await connection.sendTransaction(fund))
  run.record('authority', authority.toBase58())

  // create_market: initialize_market + deposit_liquidity(100 units), both signed by the PDA.
  const marketId = getRandomValues(new Uint8Array(6)).reduce(
    (acc, b) => (acc << 8n) | BigInt(b),
    0n,
  )
  const endTs = BigInt((await chainUnixTime(connection)) + 330)
  const market = deriveMarketPda(marketId)
  const yesMint = deriveYesMint(market)
  const noMint = deriveNoMint(market)
  const createIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: yesMint, isSigner: false, isWritable: true },
      { pubkey: noMint, isSigner: false, isWritable: true },
      { pubkey: deriveVault(market), isSigner: false, isWritable: true },
      { pubkey: metadataPda(yesMint), isSigner: false, isWritable: true },
      { pubkey: metadataPda(noMint), isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: deriveLpPosition(market, authority), isSigner: false, isWritable: true },
      { pubkey: METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PM_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc('create_market'),
      u64(marketId),
      i64(endTs),
      borshString('HRG SPIKE S2'),
      Buffer.from([0x88, 0x13]), // initial_price_bps = 5000 (u16 LE)
      u64(100_000_000n),
    ]),
  })
  const authorityBefore = await connection.getBalance(authority)
  const createTx = await send(connection, payer, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createIx,
  ])
  const createSig = await connection.sendTransaction(createTx)
  await waitForSignature(connection, createSig)
  const { stats: create } = await txStats(connection, createSig)
  run.record('create', {
    ...create,
    rentPaidByPdaSol:
      (authorityBefore - (await connection.getBalance(authority))) / LAMPORTS_PER_SOL,
  })
  run.check('CPI initialize_market + deposit_liquidity signed by the PDA', true, createSig)
  run.check(
    'invoke depth stays within the limit of 5',
    create.maxInvokeDepth <= 5,
    `depth ${create.maxInvokeDepth}`,
  )
  run.check(
    'create transaction fits in 1,232 bytes',
    create.sizeBytes <= MAX_TX_BYTES,
    `${create.sizeBytes} bytes`,
  )

  const decoded = decodeMarket((await connection.getAccountInfo(market))?.data ?? new Uint8Array())
  run.check('market.authority is the Authority PDA', decoded.authority.equals(authority))
  run.check('the PDA holds the LP position', decoded.totalLpShares > 0n && decoded.lZero > 0n)

  // A normal user swaps; the creator half of the fee lands in the PDA's treasury ATA.
  const swapSig = await pmAmmClient(connection, payer, mint).send.swap(
    market,
    'usdcToYes',
    10_000_000,
    0,
  )
  const swap = await txStats(connection, swapSig)
  const creatorFee = tokenDelta(swap.tx, authority, mint)
  run.check('creator fee reaches the PDA treasury', creatorFee > 0n, `${creatorFee} raw`)

  const resolveIx = (yesWins: boolean) =>
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: authority, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: PM_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc('resolve'), Buffer.from([yesWins ? 1 : 0])]),
    })

  // Errors from pm-AMM must surface through the CPI: resolving early is MarketNotExpired.
  const early = await connection.simulateTransaction(
    await send(connection, payer, [resolveIx(true)]),
  )
  const earlyCode = extractProgramErrorCode((early.value.logs ?? []).join('\n'))
  run.check(
    'resolve before end_ts fails with 6003 MarketNotExpired',
    earlyCode === 6003,
    `code ${earlyCode}`,
  )

  await advanceTo(Number(endTs) + 1)
  const resolveSig = await connection.sendTransaction(
    await send(connection, payer, [resolveIx(true)]),
  )
  await waitForSignature(connection, resolveSig)
  run.record('resolve', (await txStats(connection, resolveSig)).stats)
  const after = decodeMarket((await connection.getAccountInfo(market))?.data ?? new Uint8Array())
  run.check('CPI resolve_market(YES) signed by the PDA', after.resolved && after.winningSide === 1)
})
