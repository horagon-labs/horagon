import {
  heartbeat,
  insertTrades,
  markAtaClosed,
  putEvidence,
  recordSponsoredAtas,
  sponsorSpentSince,
  updateMarket,
} from '@horagon/db'
import {
  ataAddress,
  DEVNET_MUSDC_MINT,
  formatAmount,
  PM_AMM_PROGRAM_ID,
  PROTOCOL_DAO,
  parseAmount,
  quoteSwap,
  swapDirectionFor,
  toPoolState,
} from '@horagon/sdk'
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, VersionedTransaction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app'
import { DEFAULT_SPONSOR_LIMITS } from '../src/sponsor/policy'
import { MarketSet } from '../src/sponsor/submit'
import { validateSponsoredTransaction } from '../src/sponsor/validate'
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
    env = await makeEnv({ txPerHour: 1 })
    app = createApp(env.deps)
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

  it('answers 429 when the daily cap is used up', async () => {
    env = await makeEnv({ capSol: 0.000001 })
    app = createApp(env.deps)
    const built = await builtTrade()
    const res = await post('/tx/submit', { tx: signAsUser(built.tx) })
    expect(res.status).toBe(429)
    expect(env.chain.simulated).toBe(0)
  })

  it('never echoes the RPC error, never logs its key or stack, and releases the reservation', async () => {
    env.chain.sendFails = true
    const built = await builtTrade()
    const res = await post('/tx/submit', { tx: signAsUser(built.tx) })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('secret-rpc')
    expect(await sponsorSpentSince(env.h.db, new Date(0))).toBe(0n)
    const logs = env.logs.join('\n')
    expect(logs).toContain('sponsor send failed')
    expect(logs).not.toContain('XYZ')
    expect(logs).not.toContain('"stack"')
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
    env = await makeEnv({ atasPerWalletDay: ataCreates })
    app = createApp(env.deps)
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
    const tx = VersionedTransaction.deserialize(Buffer.from(body.txs[0]?.tx ?? '', 'base64'))
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58())
    expect(keys).toContain(ataAddress({ owner: wallet, mint: m.decoded.noMint }).toBase58())
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

  it('is degraded until the keeper heartbeats', async () => {
    expect((await get('/health')).status).toBe(503)
    await heartbeat(env.h.db, 'keeper', { tick: 1 })
    env.deps.now = () => Math.floor(Date.now() / 1000)
    const res = await get('/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
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
})
