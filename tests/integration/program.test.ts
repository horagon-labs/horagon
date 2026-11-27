// The horagon program against real pm-AMM, on Surfpool, whose clock moves forward on request
// (one market here lives two days). Spec 15 and 20.3: the whole lifecycle, plus a wrong-signer
// call for every instruction, quote parity near end_ts, and three cases that record what the
// program does not stop. Needs a FRESH chain with the program at its id and no Config yet
// (Config is a singleton, and the clock only moves forward). scripts/program-it.sh builds one
// and runs this file, as CI does (docs/testing.md):
//   anchor build && bash scripts/program-it.sh
// Against such a chain already running:
//   HORAGON_IT_RPC=http://127.0.0.1:8899 pnpm --filter @horagon/integration test
// The admin signs initialize_config, so it must be the program's upgrade authority on that
// chain: a throwaway key, read from HORAGON_IT_ADMIN (a keypair JSON path, default
// .keys/it-admin.json). Never the devnet deployer.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildClaimTransactions,
  buildClaimWinningsIx,
  buildTradeTransaction,
  CREATE_MARKET_COMPUTE_UNITS,
  decodeMarketAccount,
  deriveLpPosition,
  deriveVault,
  deriveYesMint,
  failedProgramError,
  HEAVY_IX_COMPUTE_UNITS,
  HoragonProgram,
  type HoragonProgramErrorName,
  marketIdFor,
  marketName,
  PM_AMM_IX_DISCRIMINATORS,
  PM_AMM_PROGRAM_ID,
  quoteSwap,
  type SwapDirection,
  toPoolState,
  tradeAtas,
} from '@horagon/sdk'
import { cdfInv, lEffective, rescaleReserves, xyFromU } from '@horagon/sdk/math'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const RPC = process.env.HORAGON_IT_RPC
const ADMIN_KEY =
  process.env.HORAGON_IT_ADMIN ?? join(import.meta.dirname, '../../.keys/it-admin.json')
const USDC = 1_000_000n
const SEED = 1_000n * USDC
const WINDOW_SECS = 60

class TxFailed extends Error {
  constructor(
    readonly signature: string,
    readonly logs: string[],
  ) {
    super(`${signature} failed:\n${logs.join('\n')}`)
  }
}

const loadKeypair = (path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]))

describe.skipIf(!RPC)('horagon program on Surfpool', () => {
  const conn = new Connection(RPC ?? 'http://127.0.0.1:8899', 'confirmed')
  const admin = RPC ? loadKeypair(ADMIN_KEY) : Keypair.generate()
  const attestor = Keypair.generate()
  const guardian = Keypair.generate()
  const stranger = Keypair.generate()
  const trader = Keypair.generate()
  const externalId = `it${Date.now() % 1e9}`
  let mint: PublicKey
  let program: HoragonProgram
  let marketId: bigint
  let residualMarketId: bigint
  let endTs: number

  async function sendTx(tx: VersionedTransaction, signers: Keypair[]): Promise<string> {
    tx.sign(signers)
    const signature = await conn.sendTransaction(tx, { skipPreflight: true })
    const latest = await conn.getLatestBlockhash('confirmed')
    // web3.js resolves with value.err when the signature subscription sees the failure, but
    // rejects with the bare TransactionError when its first status poll does (Surfpool is fast
    // enough for either), so both paths end here.
    const err = await conn.confirmTransaction({ signature, ...latest }, 'confirmed').then(
      (res) => res.value.err,
      (e: unknown) => e,
    )
    if (err) {
      const t = await conn.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      // Not a failed transaction (an expired blockhash, an RPC error): rethrow as is.
      if (!t?.meta?.err) throw err
      throw new TxFailed(signature, t.meta.logMessages ?? [])
    }
    return signature
  }

  /** Numbers worth keeping from a run (compute units by transaction, amounts); printed last. */
  const measured: Record<string, number> = {}
  /**
   * The compute units a whole transaction consumed (from its meta), within 80% of the limit it
   * set: a transaction over its limit fails anyway, so the margin is what this checks.
   */
  async function measure(label: string, signature: string, limit: number): Promise<void> {
    const t = await conn.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    const used = t?.meta?.computeUnitsConsumed
    if (used === undefined) throw new Error(`${label}: no computeUnitsConsumed in the meta`)
    expect(used, `${label} compute units`).toBeLessThanOrEqual(0.8 * limit)
    measured[`${label} CU`] = used
  }
  afterAll(() => {
    if (Object.keys(measured).length > 0) console.info(`measured: ${JSON.stringify(measured)}`)
  })

  async function send(
    ixs: TransactionInstruction[],
    payer: Keypair,
    others: Keypair[] = [],
    units = 400_000,
  ): Promise<string> {
    const { blockhash } = await conn.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs],
    }).compileToV0Message()
    const signers = [payer, ...others.filter((k) => !k.publicKey.equals(payer.publicKey))]
    return sendTx(new VersionedTransaction(message), signers)
  }

  async function expectError(
    p: Promise<unknown>,
    expected: { name: HoragonProgramErrorName } | { code: number } | { program: 'pm-amm' },
  ) {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err, 'the transaction should have failed').toBeInstanceOf(TxFailed)
    const failed = failedProgramError((err as TxFailed).logs, program.programId)
    if ('program' in expected) expect(failed?.program).toBe('pm-amm')
    else expect(failed).toMatchObject({ program: 'horagon', ...expected })
  }

  async function chainTime(): Promise<number> {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed')
    if (!info) throw new Error('no Clock sysvar')
    return Number(info.data.readBigInt64LE(32))
  }

  /** surfnet_timeTravel takes milliseconds; verify the Clock instead of trusting the call. */
  async function travelTo(unixSecs: number): Promise<void> {
    if ((await chainTime()) >= unixSecs) return
    const res = await fetch(RPC as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'surfnet_timeTravel',
        params: [{ absoluteTimestamp: unixSecs * 1000 }],
      }),
    })
    const body = (await res.json()) as { error?: unknown }
    if (body.error) throw new Error(`surfnet_timeTravel: ${JSON.stringify(body.error)}`)
    for (let i = 0; i < 40 && (await chainTime()) < unixSecs; i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(await chainTime()).toBeGreaterThanOrEqual(unixSecs)
  }

  const balance = async (owner: PublicKey) =>
    (await getAccount(conn, getAssociatedTokenAddressSync(mint, owner, true), 'confirmed')).amount
  /** A token account, or undefined when none exists there; any other failure is rethrown. */
  const tokenAccountOrNone = (address: PublicKey) =>
    getAccount(conn, address, 'confirmed').catch((e: unknown) => {
      if (e instanceof TokenAccountNotFoundError) return undefined
      throw e
    })
  const gameMarket = async (id = marketId) => {
    const gm = await program.fetchGameMarket(conn, id)
    if (!gm) throw new Error('GameMarket missing')
    return gm
  }
  const evidenceHash = createHash('sha256').update(externalId).digest()

  beforeAll(async () => {
    for (const k of [admin, attestor, guardian, stranger, trader]) {
      const sig = await conn.requestAirdrop(k.publicKey, 20e9)
      await conn.confirmTransaction(sig, 'confirmed')
    }
    if (await new HoragonProgram({ collateralMint: PublicKey.default }).fetchConfig(conn)) {
      throw new Error(
        'Config already exists: restart Surfpool so the run starts from a fresh chain',
      )
    }
    mint = await createMint(conn, admin, admin.publicKey, null, 6)
    program = new HoragonProgram({ collateralMint: mint })
    const fund = (owner: PublicKey) =>
      createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey,
        getAssociatedTokenAddressSync(mint, owner, true),
        owner,
        mint,
      )
    // The Authority PDA pays the rent of every pm-AMM market it creates (0.03538 SOL in S2).
    const rent = SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: program.authority,
      lamports: LAMPORTS_PER_SOL,
    })
    await send(
      [rent, fund(program.authority), fund(trader.publicKey), fund(admin.publicKey)],
      admin,
    )
    await mintTo(conn, admin, mint, program.treasury, admin, 10_000n * USDC)
    await mintTo(
      conn,
      admin,
      mint,
      getAssociatedTokenAddressSync(mint, trader.publicKey),
      admin,
      100n * USDC,
    )
    marketId = await marketIdFor('NBA', externalId, 0)
  })

  it('initialize_config: only the upgrade authority', async () => {
    const init = (who: Keypair) =>
      program.ix.initializeConfig({
        admin: who.publicKey,
        attestor: attestor.publicKey,
        guardians: [guardian.publicKey, PublicKey.default],
        disputeWindowSecs: WINDOW_SECS,
      })
    // The upgrade-authority constraint names its error (`@ HoragonError::Unauthorized`).
    await expectError(send([init(stranger)], stranger), { name: 'Unauthorized' })
    await send([init(admin)], admin)
    expect(await program.fetchConfig(conn)).toMatchObject({
      admin: admin.publicKey,
      attestor: attestor.publicKey,
      disputeWindowSecs: WINDOW_SECS,
      creationPaused: false,
    })
  })

  it('update_config and withdraw_treasury: admin only', async () => {
    await expectError(
      send(
        [program.ix.updateConfig({ admin: stranger.publicKey, creationPaused: true })],
        stranger,
      ),
      { name: 'Unauthorized' },
    )
    const withdraw = (who: Keypair) =>
      program.ix.withdrawTreasury({
        admin: who.publicKey,
        destination: getAssociatedTokenAddressSync(mint, admin.publicKey),
        amount: USDC,
      })
    await expectError(send([withdraw(stranger)], stranger), { name: 'Unauthorized' })
    const before = await balance(admin.publicKey)
    await send([withdraw(admin)], admin)
    expect(await balance(admin.publicKey)).toBe(before + USDC)
  })

  const createIx = (
    signer: PublicKey,
    over: {
      marketId?: bigint
      externalGameId?: string
      endTs?: number
      initialPriceBps?: number
      seedAmount?: bigint
    } = {},
  ) =>
    program.ix.createGameMarket({
      attestor: signer,
      marketId: over.marketId ?? marketId,
      kind: 0,
      league: 'NBA',
      externalGameId: over.externalGameId ?? externalId,
      home: 'BOS',
      away: 'NYK',
      scheduledTipoff: endTs - 7_800,
      endTs: over.endTs ?? endTs,
      name: marketName({
        league: 'NBA',
        away: 'NYK',
        home: 'BOS',
        gameDate: '2026-11-24',
        kind: 0,
      }),
      initialPriceBps: over.initialPriceBps ?? 6_000,
      seedAmount: over.seedAmount ?? SEED,
    })

  it('create_game_market: attestor only, validated, paused refuses, seeds from the treasury', async () => {
    const now = await chainTime()
    endTs = now + 600
    const sendCreate = (ix: TransactionInstruction, who: Keypair) =>
      send([ix], who, [], CREATE_MARKET_COMPUTE_UNITS)
    const create = (who: Keypair, over = {}) => sendCreate(createIx(who.publicKey, over), who)
    await expectError(create(stranger), { name: 'Unauthorized' })
    await expectError(create(attestor, { endTs: now + 100 }), { name: 'EndTooSoon' })
    // The SDK refuses the price before signing; to reach the program's own check, encode a
    // valid price and patch the u16, which only the u64 seed amount follows.
    expect(() => createIx(attestor.publicKey, { initialPriceBps: 400 })).toThrow(/initialPriceBps/)
    const lowPrice = createIx(attestor.publicKey)
    lowPrice.data.writeUInt16LE(400, lowPrice.data.length - 10)
    await expectError(sendCreate(lowPrice, attestor), { name: 'PriceOutOfRange' })
    await expectError(create(attestor, { seedAmount: 1_000_000n * USDC }), {
      name: 'InsufficientTreasury',
    })

    await send([program.ix.updateConfig({ admin: admin.publicKey, creationPaused: true })], admin)
    await expectError(create(attestor), { name: 'CreationPaused' })
    await send([program.ix.updateConfig({ admin: admin.publicKey, creationPaused: false })], admin)

    const treasuryBefore = await balance(program.authority)
    await measure('create_game_market', await create(attestor), CREATE_MARKET_COMPUTE_UNITS)
    const gm = await gameMarket()
    expect(gm).toMatchObject({
      status: 'open',
      seedAmount: SEED,
      endTs,
      externalGameId: externalId,
    })
    const info = await conn.getAccountInfo(gm.market, 'confirmed')
    expect(info && decodeMarketAccount(info).authority.equals(program.authority)).toBe(true)
    expect(await balance(program.authority)).toBe(treasuryBefore - SEED)
  })

  const swapOn = async (market: PublicKey, direction: SwapDirection, amountIn = 20n * USDC) => {
    const { blockhash } = await conn.getLatestBlockhash('confirmed')
    const p = {
      user: trader.publicKey,
      market,
      collateralMint: mint,
      authority: program.authority,
    }
    const tx = buildTradeTransaction({
      feePayer: trader.publicKey,
      recentBlockhash: blockhash,
      swap: { ...p, direction, amountIn, minOut: 0n },
      createAtas: tradeAtas(p),
    })
    return sendTx(tx, [trader])
  }
  const swap = async () => swapOn((await gameMarket()).market, 'usdcToYes')

  // Never halted, so its LpPosition is still open at finalize and recycle must claim the LP
  // residuals before the winnings; the halted market skips that step. It opens now, with the
  // same end_ts, because the clock only moves forward.
  it('a second market, never halted, opens and trades', async () => {
    const externalGameId = `${externalId}r`
    residualMarketId = await marketIdFor('NBA', externalGameId, 0)
    const sig = await send(
      [createIx(attestor.publicKey, { marketId: residualMarketId, externalGameId })],
      attestor,
      [],
      CREATE_MARKET_COMPUTE_UNITS,
    )
    await measure('create_game_market (never halted)', sig, CREATE_MARKET_COMPUTE_UNITS)
    const gm = await gameMarket(residualMarketId)
    expect(gm).toMatchObject({ status: 'open', endTs, externalGameId })
    await swapOn(gm.market, 'usdcToNo')
  })

  it('a player swaps; halt is attestor or guardian only and stops trading', async () => {
    await swap()
    const halt = (who: Keypair) =>
      program.ix.halt({ signer: who.publicKey, marketId }, who.publicKey)
    await expectError(send(halt(stranger), stranger, [], HEAVY_IX_COMPUTE_UNITS), {
      name: 'Unauthorized',
    })
    const sig = await send(halt(attestor), attestor, [], HEAVY_IX_COMPUTE_UNITS)
    await measure('halt', sig, HEAVY_IX_COMPUTE_UNITS)
    expect((await gameMarket()).status).toBe('halted')
    await expectError(swap(), { program: 'pm-amm' })
  })

  const propose = (who: Keypair, id = marketId, outcome: 'yes' | 'no' = 'yes') =>
    send(
      [
        program.ix.proposeResult({
          signer: who.publicKey,
          marketId: id,
          outcome,
          evidenceHash,
          evidenceUri: `https://horagon.invalid/api/v1/evidence/nba-${externalId}/winner`,
        }),
      ],
      who,
    )

  it('propose_result: not before end_ts, attestor or guardian only', async () => {
    await expectError(propose(attestor), { name: 'TooEarly' })
    await travelTo(endTs + 1)
    await expectError(propose(stranger), { name: 'Unauthorized' })
    await propose(attestor)
    const gm = await gameMarket()
    expect(gm).toMatchObject({ status: 'proposed', proposedOutcome: 'yes' })
    expect(Buffer.from(gm.evidenceHash).equals(evidenceHash)).toBe(true)
  })

  const challenge = (who: Keypair, id = marketId) =>
    send([program.ix.challenge({ guardian: who.publicKey, marketId: id })], who)
  const finalize = (payer: Keypair, id = marketId) =>
    send([program.ix.finalize({ marketId: id })], payer, [], 1_400_000)
  const recycle = (payer: Keypair, id = marketId) =>
    send(program.ix.recycle({ marketId: id }, payer.publicKey), payer, [], HEAVY_IX_COMPUTE_UNITS)

  it('challenge: guardians only, inside the window; a challenged result is proposed again', async () => {
    await expectError(challenge(stranger), { name: 'Unauthorized' })
    await expectError(challenge(attestor), { name: 'Unauthorized' })
    await challenge(guardian)
    expect((await gameMarket()).status).toBe('challenged')
    await propose(attestor)
    expect((await gameMarket()).status).toBe('proposed')
  })

  it('finalize: anyone, only after the window; resolves pm-AMM', async () => {
    await expectError(finalize(stranger), { name: 'WindowOpen' })
    const gm = await gameMarket()
    await travelTo(gm.proposedAt + WINDOW_SECS + 1)
    await expectError(challenge(guardian), { name: 'WindowClosed' })
    await finalize(stranger)
    expect((await gameMarket()).status).toBe('finalized')
    const info = await conn.getAccountInfo(gm.market, 'confirmed')
    expect(info && decodeMarketAccount(info)).toMatchObject({ resolved: true, winningSide: 1 })
  })

  it('the winner claims 1 mUSDC per YES share', async () => {
    const market = (await gameMarket()).market
    const info = await conn.getAccountInfo(market, 'confirmed')
    if (!info) throw new Error('market account missing')
    const yesAta = getAssociatedTokenAddressSync(
      decodeMarketAccount(info).yesMint,
      trader.publicKey,
    )
    const yes = (await getAccount(conn, yesAta, 'confirmed')).amount
    expect(yes).toBeGreaterThan(0n)
    const before = await balance(trader.publicKey)
    await send(
      [buildClaimWinningsIx({ user: trader.publicKey, market, collateralMint: mint })],
      trader,
    )
    expect(await balance(trader.publicKey)).toBe(before + yes)
  })

  it('recycle: anyone, once; leftover mUSDC returns to the treasury', async () => {
    const before = await balance(program.authority)
    await measure('recycle (halted)', await recycle(stranger), HEAVY_IX_COMPUTE_UNITS)
    expect((await gameMarket()).status).toBe('recycled')
    expect(await balance(program.authority)).toBeGreaterThan(before)
    await expectError(recycle(stranger), { name: 'BadStatus' })
  })

  it('recycle of a never-halted market recovers the LP residuals into the treasury', async () => {
    await propose(attestor, residualMarketId)
    const gm = await gameMarket(residualMarketId)
    await travelTo(gm.proposedAt + WINDOW_SECS + 1)
    await finalize(stranger, residualMarketId)
    expect((await gameMarket(residualMarketId)).status).toBe('finalized')
    const a = program.addresses(residualMarketId)
    expect(await conn.getAccountInfo(a.lpPosition, 'confirmed')).not.toBeNull()

    // The Authority holds no YES or NO of this market yet (it never had the accounts), so
    // whatever the treasury gains came out of the LpPosition through claim_lp_residuals.
    for (const ata of [a.authorityYes, a.authorityNo]) {
      expect(await conn.getAccountInfo(ata, 'confirmed')).toBeNull()
    }
    const before = await balance(program.authority)
    const sig = await recycle(stranger, residualMarketId)
    await measure('recycle (never halted)', sig, HEAVY_IX_COMPUTE_UNITS)
    expect((await gameMarket(residualMarketId)).status).toBe('recycled')
    // claim_lp_residuals leaves the LpPosition open with all its shares, so the check is on what
    // came back: the pool drains to its LP at resolution, and the NO buy lost.
    const recovered = (await balance(program.authority)) - before
    expect(recovered).toBeGreaterThanOrEqual(SEED / 2n)
    measured['recovered (never halted), raw mUSDC'] = Number(recovered)
    // claim_winnings burned every YES and NO the Authority held, the losing side included
    // (pm-AMM closes the emptied accounts too).
    for (const ata of [a.authorityYes, a.authorityNo]) {
      expect((await tokenAccountOrNone(ata))?.amount ?? 0n).toBe(0n)
    }
  })

  // Task 10 ruling 3(a): recycle when the Authority holds only losing-side tokens, so that
  // claim_winnings pays nothing. withdraw_liquidity (halt) mints the Authority its pending
  // residuals, its entry surplus and its share of both reserves, so a normal market leaves it
  // both sides. One side comes out empty only when all it is owed on that side is under one raw
  // unit: a 0.002 mUSDC seed at 60% (the entry surplus is then YES), two days from end_ts (the
  // NO residuals then accrue at about 0.006 raw a second), and a NO buy that takes the YES price
  // to 0.02% (the NO reserve falls to about 0.2 raw). Resolving NO leaves it losing YES only.
  it('recycle when the Authority holds only losing-side tokens: claim_winnings pays nothing', async () => {
    const externalGameId = `${externalId}l`
    const id = await marketIdFor('NBA', externalGameId, 0)
    const lossEnd = (await chainTime()) + 2 * 24 * 3600
    const created = await send(
      [
        createIx(attestor.publicKey, {
          marketId: id,
          externalGameId,
          endTs: lossEnd,
          seedAmount: 2_000n,
        }),
      ],
      attestor,
      [],
      CREATE_MARKET_COMPUTE_UNITS,
    )
    await measure('create_game_market (losing side)', created, CREATE_MARKET_COMPUTE_UNITS)
    const gm = await gameMarket(id)
    const marketState = async () => {
      const info = await conn.getAccountInfo(gm.market, 'confirmed')
      if (!info) throw new Error('market account missing')
      return decodeMarketAccount(info)
    }
    // Buy NO until x, the YES reserve, reaches its value at a 0.02% YES price: above the 0.01%
    // that pm-AMM's accrual clamps to, which would rebuild the NO reserve. The 2% fee comes off
    // the USDC first.
    const now = await chainTime()
    const pool = toPoolState(await marketState())
    const { x } = rescaleReserves(pool, now)
    const xTarget = xyFromU(cdfInv(0.0002), lEffective(pool.lZero, pool.endTs - now)).x
    await swapOn(gm.market, 'usdcToNo', BigInt(Math.ceil(((xTarget - x) * 10_000) / 9_800)) + 1n)
    expect(toPoolState(await marketState()).reserveNo).toBeLessThan(1)

    const halted = await send(
      program.ix.halt({ signer: attestor.publicKey, marketId: id }, attestor.publicKey),
      attestor,
      [],
      HEAVY_IX_COMPUTE_UNITS,
    )
    await measure('halt (losing side)', halted, HEAVY_IX_COMPUTE_UNITS)
    const a = program.addresses(id)
    const yes = (await getAccount(conn, a.authorityYes, 'confirmed')).amount
    expect(yes).toBeGreaterThan(0n)
    expect((await getAccount(conn, a.authorityNo, 'confirmed')).amount).toBe(0n)

    await travelTo(lossEnd + 1)
    await propose(attestor, id, 'no')
    await travelTo((await gameMarket(id)).proposedAt + WINDOW_SECS + 1)
    await finalize(stranger, id)
    expect(await marketState()).toMatchObject({ resolved: true, winningSide: 2 })

    const before = await balance(program.authority)
    await measure('recycle (losing side only)', await recycle(stranger, id), HEAVY_IX_COMPUTE_UNITS)
    expect((await gameMarket(id)).status).toBe('recycled')
    expect(await balance(program.authority)).toBeGreaterThanOrEqual(before)
    measured['losing YES burned (losing side only), raw'] = Number(yes)
    // claim_winnings burned the losing YES and closed both accounts.
    for (const ata of [a.authorityYes, a.authorityNo]) {
      expect((await tokenAccountOrNone(ata))?.amount ?? 0n).toBe(0n)
    }
  })

  // Tier 0 final review: L_eff shrinks with the square root of the time left, so near end_ts a
  // quote is only as good as its clock. Quoting the pool as it was before a swap, at the time
  // the swap accrued, must give what the swap paid.
  it('quotes match the chain at 30 s and 10 s left (time travel)', async () => {
    const parityId = `${externalId}p`
    const parityMarketId = await marketIdFor('NBA', parityId, 0)
    const parityEnd = (await chainTime()) + 600
    const created = await send(
      [
        program.ix.createGameMarket({
          attestor: attestor.publicKey,
          marketId: parityMarketId,
          kind: 0,
          league: 'NBA',
          externalGameId: parityId,
          home: 'BOS',
          away: 'NYK',
          scheduledTipoff: parityEnd - 7_800,
          endTs: parityEnd,
          name: marketName({
            league: 'NBA',
            away: 'NYK',
            home: 'BOS',
            gameDate: '2026-11-25',
            kind: 0,
          }),
          initialPriceBps: 6_000,
          seedAmount: SEED,
        }),
      ],
      attestor,
      [],
      CREATE_MARKET_COMPUTE_UNITS,
    )
    await measure('create_game_market (parity)', created, CREATE_MARKET_COMPUTE_UNITS)
    const gm = await program.fetchGameMarket(conn, parityMarketId)
    if (!gm) throw new Error('parity GameMarket missing')
    const marketState = async () => {
      const info = await conn.getAccountInfo(gm.market, 'confirmed')
      if (!info) throw new Error('market account missing')
      return decodeMarketAccount(info)
    }
    const yesAta = getAssociatedTokenAddressSync((await marketState()).yesMint, trader.publicKey)
    const yesHeld = async () => (await tokenAccountOrNone(yesAta))?.amount ?? 0n
    const p = {
      user: trader.publicKey,
      market: gm.market,
      collateralMint: mint,
      authority: program.authority,
    }
    const amountIn = 5n * USDC

    for (const left of [30, 10]) {
      await travelTo(parityEnd - left)
      const before = toPoolState(await marketState())
      const held = await yesHeld()
      const { blockhash } = await conn.getLatestBlockhash('confirmed')
      await sendTx(
        buildTradeTransaction({
          feePayer: trader.publicKey,
          recentBlockhash: blockhash,
          swap: { ...p, direction: 'usdcToYes', amountIn, minOut: 0n },
          createAtas: tradeAtas(p),
        }),
        [trader],
      )
      const after = toPoolState(await marketState())
      const got = (await yesHeld()) - held
      // The swap accrued at its own Clock, before end_ts.
      expect(after.lastAccrualTs).toBeGreaterThanOrEqual(parityEnd - left)
      expect(after.lastAccrualTs).toBeLessThan(parityEnd)
      const at = (now: number) => quoteSwap({ pool: before, direction: 'usdcToYes', amountIn, now })
      const q = at(after.lastAccrualTs)
      // Tier 0 measured 1.26e-7 on Surfpool and 1.06e-5 on devnet (docs/spikes.md).
      expect(Math.abs(Number(q.amountOut - got)) / Number(got), `${left} s left`).toBeLessThan(1e-4)
      expect(got).toBeGreaterThanOrEqual(q.minOut)
      // A clock 5 s behind sees more time left, so a deeper pool: never less out.
      expect(at(after.lastAccrualTs - 5).amountOut).toBeGreaterThanOrEqual(q.amountOut)
      // A clock behind the pool's last accrual is moved up to it (`effectiveTime`).
      expect(quoteSwap({ pool: after, direction: 'usdcToYes', amountIn, now: 0 })).toEqual(
        quoteSwap({ pool: after, direction: 'usdcToYes', amountIn, now: after.lastAccrualTs }),
      )
    }
  })

  // The next three cases record what the program does today where a summary could overstate it.
  // They assert current behaviour, not a wish: a change to the program that alters one of these
  // must change its case too.

  /** A market of its own (`suffix` on the external id), open for `secs` from the chain clock. */
  async function openMarket(suffix: string, secs = 600) {
    const externalGameId = `${externalId}${suffix}`
    const id = await marketIdFor('NBA', externalGameId, 0)
    const end = (await chainTime()) + secs
    await send(
      [createIx(attestor.publicKey, { marketId: id, externalGameId, endTs: end })],
      attestor,
      [],
      CREATE_MARKET_COMPUTE_UNITS,
    )
    return { id, end, gm: await gameMarket(id) }
  }

  /** pm-AMM deposit_liquidity (idls/pm_amm.json), from `owner`'s mUSDC account into `market`. */
  const depositLiquidityIx = (owner: PublicKey, market: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(16)
    data.set(PM_AMM_IX_DISCRIMINATORS.depositLiquidity, 0)
    data.writeBigUInt64LE(amount, 8)
    const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true })
    const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })
    return new TransactionInstruction({
      programId: PM_AMM_PROGRAM_ID,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        w(market),
        r(mint),
        w(deriveVault(market)),
        w(getAssociatedTokenAddressSync(mint, owner)),
        w(deriveLpPosition(market, owner)),
        r(SystemProgram.programId),
        r(TOKEN_PROGRAM_ID),
      ],
      data,
    })
  }

  /** `shares: u128` of a pm-AMM LpPosition (after the discriminator, owner and market); 0 if none. */
  const lpShares = async (address: PublicKey) => {
    const info = await conn.getAccountInfo(address, 'confirmed')
    if (!info || info.data.length < 88) return 0n
    return info.data.readBigUInt64LE(72) | (info.data.readBigUInt64LE(80) << 64n)
  }

  // halt withdraws the Authority's own LP shares and nothing else (lib.rs, `halt`), and pm-AMM's
  // deposit_liquidity takes any signer. So a wallet that deposited into a Horagon market keeps it
  // trading after the halt. The keeper's indexer flags such a market (`externalLp` in the API).
  it('halt is not a full stop when an outside wallet has deposited: a swap after the halt still fills', async () => {
    const outsider = Keypair.generate()
    await conn.confirmTransaction(await conn.requestAirdrop(outsider.publicKey, 2e9), 'confirmed')
    const outsiderUsdc = getAssociatedTokenAddressSync(mint, outsider.publicKey)
    await send(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          outsiderUsdc,
          outsider.publicKey,
          mint,
        ),
      ],
      admin,
    )
    await mintTo(conn, admin, mint, outsiderUsdc, admin, 100n * USDC)

    const { id, gm } = await openMarket('o')
    await send([depositLiquidityIx(outsider.publicKey, gm.market, 100n * USDC)], outsider)
    const outsiderLp = deriveLpPosition(gm.market, outsider.publicKey)
    const shares = await lpShares(outsiderLp)
    expect(shares).toBeGreaterThan(0n)

    await send(
      program.ix.halt({ signer: attestor.publicKey, marketId: id }, attestor.publicKey),
      attestor,
      [],
      HEAVY_IX_COMPUTE_UNITS,
    )
    expect((await gameMarket(id)).status).toBe('halted')
    expect(await lpShares(outsiderLp)).toBe(shares)

    const yesAta = getAssociatedTokenAddressSync(deriveYesMint(gm.market), trader.publicKey)
    const yesBefore = (await tokenAccountOrNone(yesAta))?.amount ?? 0n
    await swapOn(gm.market, 'usdcToYes', USDC)
    expect((await getAccount(conn, yesAta, 'confirmed')).amount).toBeGreaterThan(yesBefore)
  })

  // challenge and finalize read Config.dispute_window_secs when they run, not as it was at the
  // proposal (lib.rs, `challenge` and `finalize`), and the admin may set it at any time (60 s to
  // 7 days). Shortening it ends the window of a result already pending, the guardians' chance to
  // challenge included.
  it('the dispute window is read at call time: shortening it while a result is pending lets finalize run early', async () => {
    const longWindow = 3_600
    const setWindow = (secs: number) =>
      send([program.ix.updateConfig({ admin: admin.publicKey, disputeWindowSecs: secs })], admin)
    await setWindow(longWindow)
    try {
      const { id, end } = await openMarket('w')
      await travelTo(end + 1)
      await propose(attestor, id)
      const { proposedAt } = await gameMarket(id)
      await travelTo(proposedAt + WINDOW_SECS + 1)
      // Under the window in force at the proposal, it stays open for most of an hour.
      await expectError(finalize(stranger, id), { name: 'WindowOpen' })

      await setWindow(WINDOW_SECS)
      await expectError(challenge(guardian, id), { name: 'WindowClosed' })
      await finalize(stranger, id)
      const gm = await gameMarket(id)
      expect(gm.status).toBe('finalized')
      expect(gm.finalizedAt).toBeLessThan(proposedAt + longWindow)
    } finally {
      // The other cases run with WINDOW_SECS: put it back if a step above failed first.
      if ((await program.fetchConfig(conn))?.disputeWindowSecs !== WINDOW_SECS) {
        await setWindow(WINDOW_SECS)
      }
    }
  })

  // propose_result takes the attestor or a guardian from Open, Halted or Challenged (lib.rs,
  // `propose_result`). After a challenge, it is the keeper that leaves the next proposal to a
  // guardian (apps/keeper/src/planner.ts); the program still accepts the attestor's key, and it
  // keeps no record of the outcome that was struck.
  it('after a challenge the program takes a new proposal from the attestor, even the outcome that was struck', async () => {
    const { id, end } = await openMarket('a')
    await travelTo(end + 1)
    await propose(attestor, id, 'yes')
    await challenge(guardian, id)
    expect(await gameMarket(id)).toMatchObject({
      status: 'challenged',
      proposedOutcome: null,
      challengeCount: 1,
    })

    await propose(attestor, id, 'yes')
    const gm = await gameMarket(id)
    expect(gm).toMatchObject({ status: 'proposed', proposedOutcome: 'yes', challengeCount: 1 })
    expect(gm.proposer.equals(attestor.publicKey)).toBe(true)
    // It finalizes like any other proposal once the window has passed.
    await travelTo(gm.proposedAt + WINDOW_SECS + 1)
    await finalize(stranger, id)
    expect((await gameMarket(id)).status).toBe('finalized')
  })

  // Task 24 e2e: "Claim all" always failed, because claim_winnings closes the user's YES and NO
  // accounts itself and the SDK then appended CloseAccount on them. A user holding both sides
  // claims with the SDK's own claim transaction, a separate fee payer standing in for the
  // sponsor, as POST /tx/claim builds it. Last: it travels past its own end_ts.
  it("a user holding YES and NO claims with the SDK's claim transaction", async () => {
    const user = Keypair.generate()
    const feePayer = Keypair.generate()
    for (const k of [user, feePayer]) {
      await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 2e9), 'confirmed')
    }
    const userUsdc = getAssociatedTokenAddressSync(mint, user.publicKey)
    await send(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          userUsdc,
          user.publicKey,
          mint,
        ),
      ],
      admin,
    )
    await mintTo(conn, admin, mint, userUsdc, admin, 50n * USDC)

    const externalGameId = `${externalId}c`
    const id = await marketIdFor('NBA', externalGameId, 0)
    const claimEnd = (await chainTime()) + 600
    await send(
      [createIx(attestor.publicKey, { marketId: id, externalGameId, endTs: claimEnd })],
      attestor,
      [],
      CREATE_MARKET_COMPUTE_UNITS,
    )
    const gm = await gameMarket(id)
    const info = await conn.getAccountInfo(gm.market, 'confirmed')
    if (!info) throw new Error('market account missing')
    const { yesMint, noMint } = decodeMarketAccount(info)
    const yesAta = getAssociatedTokenAddressSync(yesMint, user.publicKey)
    const noAta = getAssociatedTokenAddressSync(noMint, user.publicKey)
    const p = {
      user: user.publicKey,
      market: gm.market,
      collateralMint: mint,
      authority: program.authority,
    }
    for (const [direction, amountIn] of [
      ['usdcToYes', 10n * USDC],
      ['usdcToNo', 20n * USDC],
    ] as const) {
      const { blockhash } = await conn.getLatestBlockhash('confirmed')
      await sendTx(
        buildTradeTransaction({
          feePayer: user.publicKey,
          recentBlockhash: blockhash,
          swap: { ...p, direction, amountIn, minOut: 0n },
          createAtas: tradeAtas(p),
        }),
        [user],
      )
    }
    const yes = (await getAccount(conn, yesAta, 'confirmed')).amount
    const no = (await getAccount(conn, noAta, 'confirmed')).amount
    expect(yes).toBeGreaterThan(0n)
    expect(no).toBeGreaterThan(0n)

    const claim = async () => {
      const { blockhash } = await conn.getLatestBlockhash('confirmed')
      const txs = buildClaimTransactions({
        user: user.publicKey,
        feePayer: feePayer.publicKey,
        recentBlockhash: blockhash,
        markets: [{ market: gm.market, collateralMint: mint }],
      })
      expect(txs).toHaveLength(1)
      return sendTx(txs[0] as VersionedTransaction, [feePayer, user])
    }

    // NO wins, as in the e2e run: the user holds winning NO and losing YES.
    await travelTo(claimEnd + 1)
    await propose(attestor, id, 'no')
    // pm-AMM refuses claim_winnings until the market is resolved, so a claim's closes always
    // mark a resolved market (the keeper's ata-watch relies on it).
    await expectError(claim(), { program: 'pm-amm' })
    await travelTo((await gameMarket(id)).proposedAt + WINDOW_SECS + 1)
    await finalize(stranger, id)
    expect((await gameMarket(id)).status).toBe('finalized')

    const usdcBefore = await balance(user.publicKey)
    const solBefore = await conn.getBalance(user.publicKey, 'confirmed')
    const outcomeRent = await Promise.all(
      [yesAta, noAta].map(async (a) => (await conn.getAccountInfo(a, 'confirmed'))?.lamports ?? 0),
    )
    const sig = await claim()
    await measure('claim_winnings (SDK claim transaction)', sig, 200_000)

    expect(await balance(user.publicKey)).toBe(usdcBefore + no)
    // claim_winnings closed both outcome accounts and paid their rent to the user, who paid no fee.
    for (const ata of [yesAta, noAta]) {
      expect(await conn.getAccountInfo(ata, 'confirmed')).toBeNull()
    }
    expect(await conn.getBalance(user.publicKey, 'confirmed')).toBe(
      solBefore + (outcomeRent[0] ?? 0) + (outcomeRent[1] ?? 0),
    )
    measured['claimed (SDK), raw mUSDC'] = Number(no)
  })
})
