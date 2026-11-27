import { Buffer } from 'node:buffer'
import {
  heartbeat,
  insertTrades,
  markAtaClosed,
  putEvidence,
  recordSponsoredAtas,
  schema,
  sponsorSpentSince,
  updateMarket,
} from '@horagon/db'
import {
  ataAddress,
  DEVNET_MUSDC_MINT,
  formatAmount,
  GameDetailSchema,
  MAINNET_GENESIS_HASH,
  PM_AMM_PROGRAM_ID,
  PROTOCOL_DAO,
  parseAmount,
  quoteSwap,
  REFERENCE_AGENT_WALLET,
  swapDirectionFor,
  toPoolState,
} from '@horagon/sdk'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, VersionedTransaction } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { pmAmmFaucet } from '../src/faucet'
import { DEFAULT_SPONSOR_LIMITS } from '../src/sponsor/policy'
import { hashIp, MarketSet } from '../src/sponsor/submit'
import { validateSponsoredTransaction } from '../src/sponsor/validate'
import { configAccount } from './config-account'
import { GAME_ID, makeEnv, program, type TestEnv, tokenAccount } from './helpers'

let env: TestEnv
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  env = await makeEnv()
  app = createApp(env.deps)
})
afterEach(async () => {
  await env.h.close()
})

/** An env with other limits; the current one is closed first, so no PGlite instance leaks. */
async function replaceEnv(opts: Parameters<typeof makeEnv>[0]) {
  await env.h.close()
  env = await makeEnv(opts)
  app = createApp(env.deps)
}

/** JSON of DB rows, bigints as text. */
const rowsText = (rows: unknown) =>
  JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? v.toString() : v))

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`/api/v1${path}`, { headers })
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

async function builtTrade(amount = '20') {
  const res = await post('/tx/trade', {
    market: env.market.pubkey.toBase58(),
    side: 'home',
    action: 'buy',
    amount,
    wallet: env.user.publicKey.toBase58(),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    tx: string
    feePayer: string
    quote: { amountOut: string; minOut: string }
  }
}

/** The CreateIdempotent instructions in a built transaction and its compute-unit limit. */
function inspect(base64: string): { ataCreates: number; cuLimit: number | undefined } {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'))
  const keys = tx.message.staticAccountKeys
  let ataCreates = 0
  let cuLimit: number | undefined
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex]
    if (program?.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) ataCreates++
    if (program?.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2) {
      cuLimit = Buffer.from(ix.data).readUInt32LE(1)
    }
  }
  return { ataCreates, cuLimit }
}

function signAsUser(base64: string): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'))
  tx.sign([env.user])
  return Buffer.from(tx.serialize()).toString('base64')
}

describe('reads', () => {
  it('lists the night by default: from 00:00 ET of the night, so a late game stays (I1)', async () => {
    const at = (iso: string) =>
      createApp({ ...env.deps, now: () => Date.parse(iso) / 1000 }).request('/api/v1/games')
    const ids = async (res: Response) =>
      ((await res.json()) as { games: Array<{ id: string }> }).games.map((g) => g.id)
    // The game tips off at 03:30Z on 20/11 (22:30 ET on the 19th).
    expect(await ids(await at('2026-11-20T05:30:00Z'))).toEqual([GAME_ID])
    expect(await ids(await at('2026-11-20T10:59:00Z'))).toEqual([GAME_ID])
    // From 06:00 ET the night is the 20th: the range starts at 00:00 ET that day.
    expect(await ids(await at('2026-11-20T11:30:00Z'))).toEqual([])
  })

  it('lists the ET game date with cache headers and a request id', async () => {
    const res = await get('/games?date=2026-11-19')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('s-maxage=1, stale-while-revalidate=5')
    expect(res.headers.get('x-request-id')).toBeTruthy()
    const body = (await res.json()) as { games: Array<{ id: string; markets: unknown[] }> }
    expect(body.games.map((g) => g.id)).toEqual([GAME_ID])
    expect(body.games[0]?.markets).toHaveLength(1)
    // Tip-off is 03:30 UTC on 20/11, still the evening of 19/11 in ET.
    const next = (await (await get('/games?date=2026-11-20')).json()) as { games: unknown[] }
    expect(next.games).toEqual([])
  })

  it('answers RFC 9457 problems for a bad and an unknown game id', async () => {
    const bad = await get('/games/NOT A GAME')
    expect(bad.status).toBe(400)
    expect(bad.headers.get('content-type')).toContain('application/problem+json')
    expect(((await bad.json()) as { code: string }).code).toBe('INVALID_INPUT')
    const missing = await get('/games/nba-999')
    expect(missing.status).toBe(404)
  })

  it('serves a weak ETag on a game and 304 on a match', async () => {
    const first = await get(`/games/${GAME_ID}`)
    expect(first.headers.get('cache-control')).toBe('s-maxage=1, stale-while-revalidate=5')
    const tag = first.headers.get('etag')
    expect(tag).toMatch(/^W\//)
    const again = await get(`/games/${GAME_ID}`, { 'if-none-match': tag ?? '' })
    expect(again.status).toBe(304)
    expect(again.headers.get('x-request-id')).toBeTruthy()
  })

  it('quotes exactly what the SDK quotes for the live account', async () => {
    const res = await get(
      `/quote?market=${env.market.pubkey.toBase58()}&side=home&action=buy&amount=20`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { amountOut: string }
    const q = quoteSwap({
      pool: toPoolState(env.market.decoded),
      direction: swapDirectionFor('home', 'buy'),
      amountIn: parseAmount('20'),
      now: env.market.swap.now,
    })
    expect(body.amountOut).toBe(formatAmount(q.amountOut))
  })

  it('answers at the last accrual of the pool when the server clock is behind it', async () => {
    const accrued = env.market.decoded.lastAccrualTs
    env.deps.now = () => accrued - 60
    const market = env.market.pubkey.toBase58()
    const state = (await (await get(`/markets/${market}`)).json()) as { now: number }
    expect(state.now).toBe(accrued)
    const res = await get(`/quote?market=${market}&side=home&action=buy&amount=20`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { amountOut: string; now: number }
    expect(body.now).toBe(accrued)
    const q = quoteSwap({
      pool: toPoolState(env.market.decoded),
      direction: swapDirectionFor('home', 'buy'),
      amountIn: parseAmount('20'),
      now: accrued,
    })
    expect(body.amountOut).toBe(formatAmount(q.amountOut))
  })

  it('refuses to quote a market that is not in the DB', async () => {
    const other = Keypair.generate().publicKey.toBase58()
    const res = await get(`/quote?market=${other}&side=home&action=buy&amount=20`)
    expect(res.status).toBe(404)
  })

  it('returns stored evidence byte for byte with its hash header', async () => {
    const json = '{"a":1,"b":"é"}'
    await putEvidence(env.h.db, { gameId: GAME_ID, kind: 0, json, hash: 'ab'.repeat(32) })
    const res = await get(`/evidence/${GAME_ID}/winner`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(json)
    expect(res.headers.get('x-evidence-sha256')).toBe('ab'.repeat(32))
  })
})

describe('GET /games/{id}: who traded (R2b)', () => {
  let n = 0
  /** A swap of `usdc` raw mUSDC on `market` (this game's by default), `secs` after the swap fixture. */
  const swap = (
    wallet: string,
    usdc: bigint,
    over: { market?: string; secs?: number; botMemo?: boolean } = {},
  ) => ({
    sig: `${String(n++).padStart(4, '1')}${'c'.repeat(84)}`,
    ixIndex: 2,
    market: over.market ?? env.market.pubkey.toBase58(),
    wallet,
    direction: 'usdcToYes',
    usdcAmount: usdc,
    usdcDelta: -usdc,
    yesDelta: usdc,
    noDelta: 0n,
    fee: 0n,
    slot: 1n,
    blockTime: new Date((env.market.swap.now + (over.secs ?? 0)) * 1000),
    ...(over.botMemo === undefined ? {} : { botMemo: over.botMemo }),
  })

  it('returns the agent, fan and other volumes from the stored swaps', async () => {
    const fan = Keypair.generate().publicKey.toBase58()
    const memoBot = Keypair.generate().publicKey.toBase58()
    await insertTrades(env.h.db, [
      swap(REFERENCE_AGENT_WALLET, 100_000_000n, { secs: 10, botMemo: true }),
      swap(REFERENCE_AGENT_WALLET, 40_500_000n, { secs: 20 }),
      swap(fan, 25_000_000n, { secs: 30 }),
      // Indexed before bot_memo existed: null, a fan.
      swap(fan, 20_000_000n, { secs: 40 }),
      // The memo on another game's market makes it a bot on this one too.
      swap(memoBot, 1_000_000n, { market: 'OtherGameMarket', botMemo: true }),
      swap(memoBot, 5_000_000n, { secs: 50, botMemo: false }),
    ])
    const res = await get(`/games/${GAME_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('s-maxage=1, stale-while-revalidate=5')
    const body = GameDetailSchema.parse(await res.json())
    const t0 = env.market.swap.now
    expect(body.activity).toEqual({
      agent: { swaps: 2, wallets: 1, volumeUsdc: '140.5', wallet: REFERENCE_AGENT_WALLET },
      fans: { swaps: 2, wallets: 1, volumeUsdc: '45' },
      others: { swaps: 1, wallets: 1, volumeUsdc: '5' },
      lastFanTradeTs: t0 + 40,
      lastAgentTradeTs: t0 + 20,
    })
  })

  it('gives zeros and nulls for a game with no swaps', async () => {
    const body = GameDetailSchema.parse(await (await get(`/games/${GAME_ID}`)).json())
    const zero = { swaps: 0, wallets: 0, volumeUsdc: '0' }
    expect(body.activity).toEqual({
      agent: { ...zero, wallet: REFERENCE_AGENT_WALLET },
      fans: zero,
      others: zero,
      lastFanTradeTs: null,
      lastAgentTradeTs: null,
    })
  })
})

describe('GET /games/{id}: the proposal and its challenge window (R6 part B)', () => {
  const proposedAt = new Date('2026-11-20T06:40:00Z')
  const propose = () =>
    updateMarket(env.h.db, env.market.pubkey.toBase58(), {
      status: 'proposed',
      outcome: 'yes',
      evidenceHash: 'ab'.repeat(32),
      proposedAt,
    })
  /** How many times the Config account was read. */
  function configReads() {
    const spy = vi.spyOn(env.deps.connection, 'getAccountInfo')
    return () => spy.mock.calls.filter(([k]) => k.equals(program.config)).length
  }
  const resolution = async () =>
    GameDetailSchema.parse(await (await get(`/games/${GAME_ID}`)).json()).resolutions[0]

  it('gives the game market, the proposal time and the window end read on chain', async () => {
    env.chain.set(program.config, configAccount(900))
    await propose()
    const reads = configReads()
    const r = await resolution()
    expect(r?.gameMarket).toBe(program.addresses(env.market.decoded.marketId).gameMarket.toBase58())
    expect(r?.proposedAt).toBe(proposedAt.getTime() / 1000)
    expect(r?.challengeEndsAt).toBe(proposedAt.getTime() / 1000 + 900)
    // The window is kept: a second page view reads no Config.
    await resolution()
    expect(reads()).toBe(1)
  })

  it('gives a null end when the Config read fails, and reads again next time', async () => {
    env.chain.set(program.config, configAccount(900))
    await propose()
    env.chain.accountsFail = true
    const r = await resolution()
    expect(r?.proposedAt).toBe(proposedAt.getTime() / 1000)
    expect(r?.challengeEndsAt).toBeNull()
    env.chain.accountsFail = false
    expect((await resolution())?.challengeEndsAt).toBe(proposedAt.getTime() / 1000 + 900)
  })

  it('reads no Config for a game with nothing proposed', async () => {
    env.chain.set(program.config, configAccount(900))
    const reads = configReads()
    const r = await resolution()
    expect(r?.proposedAt).toBeNull()
    expect(r?.challengeEndsAt).toBeNull()
    expect(reads()).toBe(0)
  })
})

describe('POST /tx/trade', () => {
  it('builds a transaction the sponsor validator accepts', async () => {
    const built = await builtTrade()
    expect(built.feePayer).toBe(env.sponsor.publicKey.toBase58())
    const tx = VersionedTransaction.deserialize(Buffer.from(built.tx, 'base64'))
    const set = new MarketSet(env.deps)
    await set.refresh(true)
    const verdict = validateSponsoredTransaction(tx, {
      sponsor: env.sponsor.publicKey,
      collateralMint: DEVNET_MUSDC_MINT,
      feeOwners: [PROTOCOL_DAO, program.authority],
      isHoragonMarket: (k) => set.hasMarket(k),
      outcomeMintMarket: (k) => set.marketOfMint(k),
      limits: DEFAULT_SPONSOR_LIMITS,
    })
    const { ataCreates, cuLimit } = inspect(built.tx)
    expect(ataCreates).toBeGreaterThan(0)
    expect(verdict).toEqual({ ok: true, user: env.user.publicKey, ataCreates })
    // Horagon's own builder: the vendored send.* helpers ask for 1,400,000, over the 1M cap.
    expect(cuLimit).toBe(800_000)
  })

  it('says INSUFFICIENT_FUNDS before building when mUSDC is short', async () => {
    const res = await post('/tx/trade', {
      market: env.market.pubkey.toBase58(),
      side: 'home',
      action: 'buy',
      amount: '5000',
      wallet: env.user.publicKey.toBase58(),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('INSUFFICIENT_FUNDS')
  })

  it('refuses a halted market', async () => {
    await updateMarket(env.h.db, env.market.pubkey.toBase58(), { status: 'halted' })
    const res = await post('/tx/trade', {
      market: env.market.pubkey.toBase58(),
      side: 'home',
      action: 'buy',
      amount: '20',
      wallet: env.user.publicKey.toBase58(),
    })
    expect(((await res.json()) as { code: string }).code).toBe('MARKET_HALTED')
  })
})

describe('POST /tx/submit', () => {
  it('signs, reserves, simulates and sends once', async () => {
    const built = await builtTrade()
    const res = await post(
      '/tx/submit',
      { tx: signAsUser(built.tx) },
      { 'x-forwarded-for': '1.2.3.4' },
    )
    expect(res.status).toBe(200)
    const { signature } = (await res.json()) as { signature: string }
    expect(signature.length).toBeGreaterThan(80)
    expect(env.chain.sent).toHaveLength(1)
    expect(await sponsorSpentSince(env.h.db, new Date(0))).toBeGreaterThan(0n)
  })

  it('rejects a tampered user signature without touching the RPC', async () => {
    const built = await builtTrade()
    const signed = Buffer.from(signAsUser(built.tx), 'base64')
    signed[1 + 64 + 3] = (signed[1 + 64 + 3] ?? 0) ^ 0xff // second signature slot
    const res = await post('/tx/submit', { tx: signed.toString('base64') })
    expect(res.status).toBe(400)
    expect(env.chain.simulated).toBe(0)
  })

  it('rejects a user signature that belongs to a different message', async () => {
    const a = VersionedTransaction.deserialize(
      Buffer.from(signAsUser((await builtTrade('20')).tx), 'base64'),
    )
    const b = VersionedTransaction.deserialize(
      Buffer.from(signAsUser((await builtTrade('10')).tx), 'base64'),
    )
    const sigB = b.signatures[1]
    if (!sigB) throw new Error('no signature')
    a.signatures[1] = sigB
    const res = await post('/tx/submit', { tx: Buffer.from(a.serialize()).toString('base64') })
    expect(res.status).toBe(400)
    expect(env.chain.sent).toHaveLength(0)
  })

  it('rejects malformed base64 and oversized bodies', async () => {
    expect((await post('/tx/submit', { tx: 'AAAA' })).status).toBe(400)
    expect((await post('/tx/submit', { tx: 'x'.repeat(5_000) })).status).toBe(413)
  })

  it('rate-limits per wallet with retry-after', async () => {
    await replaceEnv({ txPerHour: 1 })
    const first = await builtTrade()
    expect((await post('/tx/submit', { tx: signAsUser(first.tx) })).status).toBe(200)
    const second = await builtTrade('10')
    const res = await post('/tx/submit', { tx: signAsUser(second.tx) })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('maps a 6007 simulation to SLIPPAGE_EXCEEDED and releases the reservation', async () => {
    env.chain.simulateErr = { InstructionError: [2, { Custom: 6007 }] }
    const built = await builtTrade()
    const res = await post('/tx/submit', { tx: signAsUser(built.tx) })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('SLIPPAGE_EXCEEDED')
    expect(env.chain.sent).toHaveLength(0)
    expect(await sponsorSpentSince(env.h.db, new Date(0))).toBe(0n)
  })

  it('keeps a raw simulation failure in the server log, never in the answer', async () => {
    env.chain.simulateErr = { InstructionError: [1, 'InvalidAccountData'] }
    env.chain.simulateLogs = [
      'Program log: raw-marker',
      'failed at https://rpc.example/?api-key=KEYVALUE',
    ]
    const built = await builtTrade()
    const res = await post('/tx/submit', { tx: signAsUser(built.tx) })
    const body = await res.text()
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body).not.toMatch(/InstructionError|raw-marker|KEYVALUE|[{]"InstructionError/)
    const logs = env.logs.join(String.fromCharCode(10))
    expect(logs).toContain('InstructionError')
    expect(logs).toContain('raw-marker')
    expect(logs).not.toContain('KEYVALUE')
  })

  it('answers 429 when the daily cap is used up', async () => {
    await replaceEnv({ capSol: 0.000001 })
    const built = await builtTrade()
    const res = await post('/tx/submit', { tx: signAsUser(built.tx) })
    expect(res.status).toBe(429)
    expect(env.chain.simulated).toBe(0)
  })

  it('answers a failed send with its signature and keeps the reservation, never echoing the RPC error', async () => {
    env.chain.sendFails = true
    const built = await builtTrade()
    const res = await post('/tx/submit', { tx: signAsUser(built.tx) })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain('secret-rpc')
    const problem = JSON.parse(text) as { code: string; signature: string; hint: string }
    expect(problem.code).toBe('NETWORK')
    expect(problem.signature.length).toBeGreaterThan(80)
    expect(problem.hint).toContain(`/tx/${problem.signature}`)
    // The node may have taken it before the error: the spend stays reserved.
    expect(await sponsorSpentSince(env.h.db, new Date(0))).toBeGreaterThan(0n)
    const logs = env.logs.join('\n')
    expect(logs).toContain('sponsor send failed')
    expect(logs).not.toContain('XYZ')
    expect(logs).not.toContain('"stack"')
  })

  it('releases the reservation when the simulation cannot reach the RPC', async () => {
    env.chain.simulateFails = true
    const res = await post('/tx/submit', { tx: signAsUser((await builtTrade()).tx) })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('secret-rpc')
    expect(env.chain.sent).toHaveLength(0)
    expect(await sponsorSpentSince(env.h.db, new Date(0))).toBe(0n)
    expect(env.logs.join('\n')).not.toContain('XYZ')
  })

  it('answers the same signed transaction twice with one signature, simulating and sending once', async () => {
    const signed = signAsUser((await builtTrade()).tx)
    const first = await post('/tx/submit', { tx: signed })
    const again = await post('/tx/submit', { tx: signed })
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(await first.json())
    expect(env.chain.simulated).toBe(1)
    expect(env.chain.sent).toHaveLength(1)
    expect(await env.h.db.select().from(schema.sponsorLog)).toHaveLength(1)
  })

  it('signs nothing for an RPC whose genesis hash is mainnet', async () => {
    env.chain.genesisHash = MAINNET_GENESIS_HASH
    const signed = signAsUser((await builtTrade()).tx)
    const sign = vi.spyOn(VersionedTransaction.prototype, 'sign')
    try {
      const res = await post('/tx/submit', { tx: signed })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: 'MAINNET_DISABLED' })
      expect(sign).not.toHaveBeenCalled()
    } finally {
      sign.mockRestore()
    }
    expect(env.chain.simulated).toBe(0)
    expect(env.chain.sent).toHaveLength(0)
    expect(await sponsorSpentSince(env.h.db, new Date(0))).toBe(0n)
  })

  it('fails closed when the genesis hash cannot be read, and checks again next time', async () => {
    env.chain.genesisFails = true
    const signed = signAsUser((await builtTrade()).tx)
    const sign = vi.spyOn(VersionedTransaction.prototype, 'sign')
    try {
      const res = await post('/tx/submit', { tx: signed })
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ code: 'NETWORK' })
      expect(sign).not.toHaveBeenCalled()
    } finally {
      sign.mockRestore()
    }
    expect(env.chain.simulated).toBe(0)
    env.chain.genesisFails = false
    expect((await post('/tx/submit', { tx: signed })).status).toBe(200)
    expect(env.chain.genesisCalls).toBe(2)
  })

  it('checks the genesis hash once across submits', async () => {
    expect((await post('/tx/submit', { tx: signAsUser((await builtTrade()).tx) })).status).toBe(200)
    const second = signAsUser((await builtTrade('10')).tx)
    expect((await post('/tx/submit', { tx: second })).status).toBe(200)
    expect(env.chain.sent).toHaveLength(2)
    expect(env.chain.genesisCalls).toBe(1)
  })

  it('keys the per-IP limit on the left-most x-forwarded-for and stores only its hash', async () => {
    const res = await post(
      '/tx/submit',
      { tx: signAsUser((await builtTrade()).tx) },
      { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    )
    expect(res.status).toBe(200)
    const ipHash = await hashIp('203.0.113.7', env.deps.ipSalt)
    const log = await env.h.db.select().from(schema.sponsorLog)
    expect(log.map((r) => r.ipHash)).toEqual([ipHash])
    const limits = await env.h.db.select().from(schema.rateLimits)
    expect(limits.map((r) => r.key)).toContain(`sponsor:ip:${ipHash}`)
    for (const text of [rowsText(log), rowsText(limits), env.logs.join('\n')]) {
      expect(text).not.toContain('203.0.113.7')
    }
  })

  it('counts the rent of every ATA it creates as spend at once', async () => {
    const built = await builtTrade()
    const { ataCreates } = inspect(built.tx)
    expect((await post('/tx/submit', { tx: signAsUser(built.tx) })).status).toBe(200)
    const rent = BigInt(await env.chain.asConnection().getMinimumBalanceForRentExemption(165))
    expect(await sponsorSpentSince(env.h.db, new Date(0))).toBeGreaterThanOrEqual(
      BigInt(ataCreates) * rent + 10_000n,
    )
  })

  it('caps the token accounts it opens for a wallet in a day', async () => {
    const first = await builtTrade()
    const { ataCreates } = inspect(first.tx)
    await replaceEnv({ atasPerWalletDay: ataCreates })
    expect((await post('/tx/submit', { tx: signAsUser((await builtTrade()).tx) })).status).toBe(200)
    const res = await post('/tx/submit', { tx: signAsUser((await builtTrade('10')).tx) })
    expect(res.status).toBe(429)
    expect(((await res.json()) as { hint: string }).hint).toMatch(/already hold YES and NO/)
    expect(env.chain.sent).toHaveLength(1)
    const rent = BigInt(await env.chain.asConnection().getMinimumBalanceForRentExemption(165))
    expect(await sponsorSpentSince(env.h.db, new Date(0))).toBeLessThan(
      2n * BigInt(ataCreates) * rent,
    )
  })

  it('gives the wallet its token-account budget back when the IP budget refuses', async () => {
    const { ataCreates } = inspect((await builtTrade()).tx)
    // The wallet can open two trades' worth a day, each IP one trade's worth.
    await replaceEnv({ atasPerWalletDay: 2 * ataCreates, atasPerIpDay: ataCreates })
    const from = (ip: string) => ({ 'x-forwarded-for': ip })
    const submit = async (amount: string, ip: string) =>
      post('/tx/submit', { tx: signAsUser((await builtTrade(amount)).tx) }, from(ip))
    expect((await submit('20', '198.51.100.1')).status).toBe(200)
    const refused = await submit('21', '198.51.100.1')
    expect(refused.status).toBe(429)
    expect(await refused.json()).toMatchObject({ code: 'RATE_LIMITED' })
    // Without the refund the wallet would be out too, and this would be a 429.
    expect((await submit('22', '198.51.100.2')).status).toBe(200)
    expect(env.chain.sent).toHaveLength(2)
  })

  it('opens no token accounts for a wallet that closed sponsor-paid ones elsewhere', async () => {
    const wallet = env.user.publicKey.toBase58()
    const createdAt = new Date('2026-11-24T01:00:00Z')
    await recordSponsoredAtas(env.h.db, [
      { ata: 'A1', wallet, mint: 'M', createdSig: 'S1', createdAt },
    ])
    await markAtaClosed(env.h.db, 'A1', {
      closedSig: 'S2',
      closedAt: createdAt,
      closedTo: Keypair.generate().publicKey.toBase58(),
    })
    const res = await post('/tx/submit', { tx: signAsUser((await builtTrade()).tx) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      code: 'SPONSOR_REJECTED',
      reason: 'ATA_CLOSED_AWAY',
    })
    expect(env.chain.simulated).toBe(0)
  })

  it('answers 503 without detail when a policy callback throws', async () => {
    const built = await builtTrade()
    const spy = vi.spyOn(MarketSet.prototype, 'hasMarket').mockImplementation(() => {
      throw new Error('db down at https://db.example/x?token=SECRET')
    })
    try {
      const res = await post('/tx/submit', { tx: signAsUser(built.tx) })
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ code: 'SPONSOR_REJECTED', reason: 'POLICY_ERROR' })
      expect(env.logs.join('\n')).not.toContain('SECRET')
      expect(env.chain.sent).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('status, claim, positions, faucet, health', () => {
  const sig = '5'.repeat(88)

  it('maps signature statuses', async () => {
    expect(((await (await get(`/tx/${sig}`)).json()) as { status: string }).status).toBe('unknown')
    env.chain.statuses.set(sig, {
      slot: 9,
      confirmations: null,
      err: null,
      confirmationStatus: 'confirmed',
    })
    expect(((await (await get(`/tx/${sig}`)).json()) as { status: string }).status).toBe(
      'confirmed',
    )
    env.chain.statuses.set(sig, {
      slot: 9,
      confirmations: null,
      err: { InstructionError: [0, { Custom: 6007 }] },
      confirmationStatus: 'confirmed',
    })
    const failed = (await (await get(`/tx/${sig}`)).json()) as {
      status: string
      error: { code: string }
    }
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'SLIPPAGE_EXCEEDED' } })
  })

  it('answers a failed signature in words with a hint, keeping the raw error in the log', async () => {
    const sig = 's'.repeat(88)
    env.chain.statuses.set(sig, {
      slot: 9,
      confirmations: null,
      err: { InstructionError: [1, 'InvalidAccountData'] },
      confirmationStatus: 'confirmed',
    })
    const res = await get(`/tx/${sig}`)
    const text = await res.text()
    const body = JSON.parse(text) as { error: { message: string; hint: string } }
    expect(body.error.message).toMatch(/invalid account data/)
    expect(body.error.hint).toBeTruthy()
    expect(text).not.toContain('InstructionError')
    expect(env.logs.join(String.fromCharCode(10))).toContain('InstructionError')
  })

  it('builds a claim that creates the missing NO ATA for a YES winner', async () => {
    const wallet = env.user.publicKey
    const m = env.market
    await insertTrades(env.h.db, [
      {
        sig: 'a'.repeat(88),
        ixIndex: 2,
        market: m.pubkey.toBase58(),
        wallet: wallet.toBase58(),
        direction: 'usdcToYes',
        usdcAmount: 20_000_000n,
        usdcDelta: -20_000_000n,
        yesDelta: 38_721_969n,
        noDelta: 0n,
        fee: 0n,
        slot: 1n,
        blockTime: new Date(m.swap.now * 1000),
      },
    ])
    await updateMarket(env.h.db, m.pubkey.toBase58(), { status: 'finalized', outcome: 'yes' })
    const resolved = Buffer.from(m.data)
    resolved[312] = 1 // resolved
    resolved[313] = 1 // YES won
    env.chain.set(m.pubkey, {
      data: resolved,
      owner: PM_AMM_PROGRAM_ID,
      lamports: 1,
      executable: false,
      rentEpoch: 0,
    })
    env.chain.set(
      ataAddress({ owner: wallet, mint: m.decoded.yesMint }),
      tokenAccount(m.decoded.yesMint, wallet, 38_721_969n),
    )
    const res = await post('/tx/claim', { wallet: wallet.toBase58() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { txs: Array<{ tx: string }>; markets: string[] }
    expect(body.markets).toEqual([m.pubkey.toBase58()])
    expect(body.txs).toHaveLength(1)
    const tx = VersionedTransaction.deserialize(Buffer.from(body.txs[0]?.tx ?? '', 'base64'))
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58())
    expect(keys).toContain(ataAddress({ owner: wallet, mint: m.decoded.noMint }).toBase58())
    // claim_winnings closes YES and NO itself (rent to the user), so the claim is last: a
    // CloseAccount after it would fail the whole transaction on chain.
    const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex])
    expect(programs).not.toContain(TOKEN_PROGRAM_ID.toBase58())
    expect(programs.at(-1)).toBe(PM_AMM_PROGRAM_ID.toBase58())
    // The sponsor co-signs exactly what the API built.
    const set = new MarketSet(env.deps)
    await set.refresh(true)
    const verdict = validateSponsoredTransaction(tx, {
      sponsor: env.sponsor.publicKey,
      collateralMint: DEVNET_MUSDC_MINT,
      feeOwners: [PROTOCOL_DAO, program.authority],
      isHoragonMarket: (k) => set.hasMarket(k),
      outcomeMintMarket: (k) => set.marketOfMint(k),
      limits: DEFAULT_SPONSOR_LIMITS,
    })
    expect(verdict).toEqual({
      ok: true,
      user: wallet,
      ataCreates: inspect(body.txs[0]?.tx ?? '').ataCreates,
    })
  })

  it('reports an open position at the indexed or initial price', async () => {
    const m = env.market
    await insertTrades(env.h.db, [
      {
        sig: 'b'.repeat(88),
        ixIndex: 2,
        market: m.pubkey.toBase58(),
        wallet: env.user.publicKey.toBase58(),
        direction: 'usdcToYes',
        usdcAmount: 20_000_000n,
        usdcDelta: -20_000_000n,
        yesDelta: 38_721_969n,
        noDelta: 0n,
        fee: 0n,
        slot: 1n,
        blockTime: new Date(m.swap.now * 1000),
      },
    ])
    const body = (await (await get(`/positions/${env.user.publicKey.toBase58()}`)).json()) as {
      usdcBalance: string | null
      positions: Array<{ side: string; shares: string; costUsdc: string }>
    }
    expect(body.usdcBalance).toBe('1000')
    expect(body.positions).toHaveLength(1)
    expect(body.positions[0]).toMatchObject({ side: 'home', shares: '38.721969', costUsdc: '20' })
  })

  it('still answers positions with a null balance while RPC is down', async () => {
    env.chain.accountsFail = true
    const res = await get(`/positions/${env.user.publicKey.toBase58()}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ usdcBalance: null, positions: [] })
  })

  it('lets a wallet claim the faucet once an hour', async () => {
    const wallet = env.user.publicKey.toBase58()
    expect((await post('/faucet', { wallet })).status).toBe(200)
    const again = await post('/faucet', { wallet })
    expect(again.status).toBe(429)
    expect(env.faucetCalls).toEqual([wallet])
  })

  it('limits the faucet per IP by x-forwarded-for, giving the refused wallet its token back', async () => {
    const ip = { 'x-forwarded-for': '198.51.100.9' }
    const wallets = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58())
    for (const wallet of wallets.slice(0, 5)) {
      expect((await post('/faucet', { wallet }, ip)).status).toBe(200)
    }
    const last = wallets[5] ?? ''
    expect((await post('/faucet', { wallet: last }, ip)).status).toBe(429)
    const elsewhere = await post(
      '/faucet',
      { wallet: last },
      { 'x-forwarded-for': '198.51.100.10' },
    )
    expect(elsewhere.status).toBe(200)
    expect(env.faucetCalls).toEqual(wallets)
  })

  const upstream = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  const claimed = { ok: true, signature: '5'.repeat(88), amount: 1000 }

  it('gives the allowance back when the upstream faucet fails, so a retry works', async () => {
    const replies = [upstream(500, { error: 'down' }), upstream(200, claimed)]
    let calls = 0
    env.deps.faucet = pmAmmFaucet('https://faucet.test/api/faucet', (async () => {
      calls++
      return replies.shift() ?? upstream(500, {})
    }) as unknown as typeof fetch)
    const wallet = env.user.publicKey.toBase58()
    const failed = await post('/faucet', { wallet })
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ code: 'NETWORK' })
    const retry = await post('/faucet', { wallet })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ signature: claimed.signature, amountUsdc: '1000' })
    expect(calls).toBe(2)
  })

  it('keeps the allowance spent when the upstream faucet says the wallet already claimed', async () => {
    let calls = 0
    env.deps.faucet = pmAmmFaucet('https://faucet.test/api/faucet', (async () => {
      calls++
      return upstream(429, { error: 'once an hour' }, { 'retry-after': '1200' })
    }) as unknown as typeof fetch)
    const wallet = env.user.publicKey.toBase58()
    const first = await post('/faucet', { wallet })
    expect(first.status).toBe(429)
    expect(first.headers.get('retry-after')).toBe('1200')
    expect((await post('/faucet', { wallet })).status).toBe(429)
    expect(calls).toBe(1)
  })

  it('is degraded until the keeper heartbeats', async () => {
    expect((await get('/health')).status).toBe(503)
    await heartbeat(env.h.db, 'keeper', { tick: 1 })
    env.deps.now = () => Math.floor(Date.now() / 1000)
    const res = await get('/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('bad requests and failures', () => {
  const json = (text: string) => new TextEncoder().encode(text)

  it.each([
    ['malformed JSON', { 'content-type': 'application/json' }, '{"market":', 400],
    ['no content type', {}, '{}', 415],
    ['a wrong content type', { 'content-type': 'text/plain' }, '{}', 415],
  ])('answers %s with a 4xx problem, not a 500', async (_, headers, body, status) => {
    const res = await app.request('/api/v1/tx/trade', {
      method: 'POST',
      headers: headers as Record<string, string>,
      body: json(body as string),
    })
    expect(res.status).toBe(status)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT', status })
    expect(env.logs.join('\n')).not.toContain('unhandled')
  })

  it('labels validation issues by where they are: body, query or params', async () => {
    const detail = async (res: Response | Promise<Response>) =>
      ((await (await res).json()) as { detail: string }).detail
    const market = env.market.pubkey.toBase58()
    expect(await detail(get(`/quote?market=${market}&side=up&action=buy&amount=1`))).toMatch(
      /^query\.side: /,
    )
    const trade = { market: 'x', side: 'home', action: 'buy', amount: '1' }
    expect(
      await detail(post('/tx/trade', { ...trade, wallet: env.user.publicKey.toBase58() })),
    ).toMatch(/^body\.market: /)
    expect(await detail(get('/games/NOT A GAME'))).toMatch(/^params\.id: /)
  })

  it('logs the cause of an RPC failure once, at warn, summarized', async () => {
    env.chain.accountsFail = true
    const market = env.market.pubkey.toBase58()
    const res = await get(`/quote?market=${market}&side=home&action=buy&amount=20`)
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('secret-rpc')
    const warns = env.logs.filter((l) => (JSON.parse(l) as { level: number }).level === 40)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('fetch failed')
    expect(warns[0]).not.toContain('XYZ')
    expect(warns[0]).not.toContain('"stack"')
  })
})

describe('CORS', () => {
  const preflight = (path: string) =>
    app.request(`/api/v1${path}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://bot.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })

  it('lets other origins POST to /tx/* and only GET elsewhere', async () => {
    const tx = await preflight('/tx/submit')
    expect(tx.headers.get('access-control-allow-methods')).toBe('GET,POST')
    expect(tx.headers.get('access-control-allow-origin')).toBe('*')
    const faucet = await preflight('/faucet')
    expect(faucet.headers.get('access-control-allow-methods')).toBe('GET')
  })

  it('lets other origins read the useful headers, on a 304 too', async () => {
    const origin = { origin: 'https://bot.example' }
    const first = await get(`/games/${GAME_ID}`, origin)
    expect(first.headers.get('access-control-allow-origin')).toBe('*')
    expect(first.headers.get('access-control-expose-headers')).toContain('x-request-id')
    const again = await get(`/games/${GAME_ID}`, {
      ...origin,
      'if-none-match': first.headers.get('etag') ?? '',
    })
    expect(again.status).toBe(304)
    expect(again.headers.get('access-control-allow-origin')).toBe('*')
    expect(again.headers.get('access-control-expose-headers')).toContain('retry-after')
  })
})
