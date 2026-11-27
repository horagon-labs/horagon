import type { Resolution } from '@horagon/sdk'
import { canonicalize, type ResolutionEvidence, sha256, toHex } from '@horagon/sdk/evidence'
import {
  asciiField,
  BorshWriter,
  deriveConfig,
  deriveGameMarket,
  HORAGON_ACCOUNT_DISCRIMINATORS,
  HORAGON_PROGRAM_ID,
} from '@horagon/sdk/program'
import { Keypair, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { curlLine, rpcAccount, type VerifyDeps, verifyMarket } from '../lib/verify'
import { lookupTarget } from '../lib/verify-target'

const MARKET_ID = 77n
const MARKET = Keypair.generate().publicKey.toBase58()
const GAME_MARKET = deriveGameMarket(MARKET_ID).toBase58()
const CONFIG = deriveConfig().toBase58()
const ATTESTOR = Keypair.generate().publicKey
const GUARDIAN = Keypair.generate().publicKey
const URI = 'https://horagon.test/api/v1/evidence/nba-401810001/winner'
const API_URL = 'https://www.horagon.test/api/v1/evidence/nba-401810001/winner'
const PROPOSED_AT = 1_795_012_000
const STATUS = { open: 0, proposed: 2, challenged: 3, finalized: 4 } as const

const EVIDENCE: ResolutionEvidence = {
  v: 1,
  league: 'NBA',
  gameId: '401810001',
  kind: 0,
  home: 'CLE',
  away: 'MEM',
  homeScore: 110,
  awayScore: 104,
  periods: [
    [30, 25],
    [28, 27],
    [26, 30],
    [26, 22],
  ],
  status: 'final',
  rule: 'winner-incl-ot',
  outcome: 'yes',
  sources: [
    {
      name: 'espn',
      url: 'https://site.api.espn.com/scoreboard',
      fetchedAt: '2026-11-20T06:30:00Z',
    },
  ],
}
const BODY = canonicalize(EVIDENCE)
const utf8 = (s: string) => new TextEncoder().encode(s)
const HASH = await sha256(utf8(BODY))

interface Fields {
  status?: number
  market?: string
  outcome?: number | null
  hash?: Uint8Array
  uri?: string
  proposer?: PublicKey
  gameId?: string
}

function gameMarketData(f: Fields = {}): Uint8Array {
  const proposed = (f.status ?? STATUS.proposed) !== STATUS.challenged
  return new BorshWriter()
    .fixed(Uint8Array.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket), 8)
    .pubkey(new PublicKey(f.market ?? MARKET))
    .u64(MARKET_ID)
    .u8(0)
    .fixed(asciiField('NBA', 8, 'league'), 8)
    .string(f.gameId ?? '401810001', 16)
    .fixed(asciiField('CLE', 4, 'home'), 4)
    .fixed(asciiField('MEM', 4, 'away'), 4)
    .i64(1_795_000_000)
    .i64(1_795_010_800)
    .u64(300_000_000n)
    .u8(f.status ?? STATUS.proposed)
    .option<number>(proposed ? (f.outcome === undefined ? 0 : f.outcome) : null, (w, v) => w.u8(v))
    .fixed(proposed ? (f.hash ?? HASH) : new Uint8Array(32), 32)
    .string(proposed ? (f.uri ?? URI) : '', 128)
    .i64(proposed ? PROPOSED_AT : 0)
    .pubkey(proposed ? (f.proposer ?? ATTESTOR) : PublicKey.default)
    .u8(proposed ? 0 : 1)
    .i64(0)
    .u8(255)
    .toBuffer()
}

function configData(windowSecs = 900): Uint8Array {
  return new BorshWriter()
    .fixed(Uint8Array.from(HORAGON_ACCOUNT_DISCRIMINATORS.Config), 8)
    .pubkey(Keypair.generate().publicKey)
    .pubkey(ATTESTOR)
    .pubkey(GUARDIAN)
    .pubkey(PublicKey.default)
    .u32(windowSecs)
    .pubkey(Keypair.generate().publicKey)
    .bool(false)
    .u8(254)
    .toBuffer()
}

/** A chain of two accounts and an evidence host; `served` answers each URL, or fails it. */
function deps(
  over: { gameMarket?: Uint8Array; owner?: string; served?: Record<string, string | null> } = {},
): VerifyDeps & { fetched: string[] } {
  const program = HORAGON_PROGRAM_ID.toBase58()
  const accounts = new Map([
    [GAME_MARKET, { owner: over.owner ?? program, data: over.gameMarket ?? gameMarketData() }],
    [CONFIG, { owner: program, data: configData() }],
  ])
  const served = over.served ?? { [URI]: BODY }
  const fetched: string[] = []
  return {
    fetched,
    account: async (address) => accounts.get(address) ?? null,
    fetchBytes: async (url) => {
      fetched.push(url)
      const body = served[url]
      if (body === undefined || body === null) throw new Error('fetch failed')
      return utf8(body)
    },
  }
}

const input = { market: MARKET, gameMarket: GAME_MARKET, evidenceUrl: API_URL }
const byId = (r: Awaited<ReturnType<typeof verifyMarket>>, id: string) =>
  r.checks.find((c) => c.id === id)

describe('verifyMarket (R6 part B: /verify/[market])', () => {
  it('matches the published evidence with the one on chain, every check passing', async () => {
    const r = await verifyMarket(deps(), input)
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([
      ['owner', true],
      ['address', true],
      ['market', true],
      ['hash', true],
      ['canonical', true],
      ['evidence', true],
      ['proposer', true],
    ])
    expect(r.verdict).toEqual({
      kind: 'match',
      text: 'Match: the published evidence is the one on chain',
    })
    // Both values in full.
    expect(byId(r, 'hash')?.values).toEqual([
      { name: 'On chain', value: toHex(HASH) },
      { name: 'Computed', value: toHex(HASH) },
    ])
    expect(byId(r, 'address')?.values.map((v) => v.value)).toEqual([GAME_MARKET, GAME_MARKET])
    expect(byId(r, 'proposer')?.values[1]?.value).toBe(
      `${ATTESTOR.toBase58()} (automated attestor)`,
    )
    expect(r.windowEndsAt).toBe(PROPOSED_AT + 900)
    expect(r.status).toBe('proposed')
    expect(r.evidenceUri).toBe(URI)
    expect(r.curl).toBe(`curl -s '${URI}' | sha256sum`)
  })

  it('names a guardian proposer', async () => {
    const r = await verifyMarket(
      deps({ gameMarket: gameMarketData({ proposer: GUARDIAN }) }),
      input,
    )
    expect(byId(r, 'proposer')?.ok).toBe(true)
    expect(byId(r, 'proposer')?.values[1]?.value).toBe(`${GUARDIAN.toBase58()} (guardian)`)
  })

  it('fails the hash check when one byte of the evidence changed', async () => {
    const changed = BODY.replace('"homeScore":110', '"homeScore":111')
    const r = await verifyMarket(deps({ served: { [URI]: changed } }), input)
    expect(byId(r, 'hash')?.ok).toBe(false)
    expect(r.verdict).toEqual({
      kind: 'fail',
      text: 'No match: the evidence does not hash to the hash on chain',
    })
  })

  it('stops at the owner check for an account another program owns', async () => {
    const r = await verifyMarket(deps({ owner: Keypair.generate().publicKey.toBase58() }), input)
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([['owner', false]])
    expect(r.verdict.text).toBe('No match: the account is not a Horagon GameMarket')
  })

  it('fails the market check when the account is another market’s', async () => {
    const other = Keypair.generate().publicKey.toBase58()
    const r = await verifyMarket(deps({ gameMarket: gameMarketData({ market: other }) }), input)
    expect(byId(r, 'market')).toMatchObject({
      ok: false,
      values: [
        { name: 'This page', value: MARKET },
        { name: 'On chain', value: other },
      ],
    })
    expect(r.verdict.text).toBe('No match: the account belongs to another market')
  })

  it('falls back to the API copy when the URI on chain does not answer, and says so', async () => {
    const d = deps({ served: { [URI]: null, [API_URL]: BODY } })
    const r = await verifyMarket(d, input)
    expect(d.fetched).toEqual([URI, API_URL])
    expect(byId(r, 'hash')?.ok).toBe(true)
    expect(byId(r, 'hash')?.note).toBe(
      "The URI on chain did not answer, so the evidence was read from Horagon's API copy.",
    )
    expect(r.verdict.kind).toBe('match')
  })

  it('fails the result check when the evidence names another game', async () => {
    const r = await verifyMarket(
      deps({ gameMarket: gameMarketData({ gameId: '401810002' }) }),
      input,
    )
    expect(byId(r, 'evidence')?.ok).toBe(false)
    expect(r.verdict.text).toBe('No match: the evidence does not name the result on chain')
  })

  it('has no evidence to check after a challenge', async () => {
    const r = await verifyMarket(
      deps({ gameMarket: gameMarketData({ status: STATUS.challenged }) }),
      input,
    )
    expect(r.checks.map((c) => c.id)).toEqual(['owner', 'address', 'market'])
    expect(r.status).toBe('challenged')
    expect(r.verdict).toEqual({
      kind: 'wait',
      text: 'Under review: a guardian challenged the proposed result, so no evidence is on chain until a guardian proposes again.',
    })
    expect(r.curl).toBeNull()
  })

  it('never builds a curl line that a quote in the URI could break', () => {
    expect(curlLine("https://x.test/a'b")).toBeNull()
    expect(curlLine('javascript:alert(1)')).toBeNull()
    expect(curlLine(URI)).toBe(`curl -s '${URI}' | sha256sum`)
  })
})

describe('rpcAccount (plain-fetch JSON-RPC, no web3 Connection)', () => {
  it('asks getAccountInfo in base64 at confirmed and decodes the answer', async () => {
    const sent: Array<{ url: string; body: unknown }> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) })
      const value = { owner: 'Own1111', data: [btoa('\u0001\u0002\u0003'), 'base64'] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }))
    }) as typeof fetch
    const a = await rpcAccount(fetchFn, 'https://api.devnet.solana.com', GAME_MARKET)
    expect(sent).toEqual([
      {
        url: 'https://api.devnet.solana.com',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [GAME_MARKET, { encoding: 'base64', commitment: 'confirmed' }],
        },
      },
    ])
    expect(a?.owner).toBe('Own1111')
    expect([...(a?.data ?? [])]).toEqual([1, 2, 3])
  })

  it('answers null for no account, and throws on an RPC error', async () => {
    const answer = (body: unknown) =>
      (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
    expect(await rpcAccount(answer({ result: { value: null } }), 'https://r.test', CONFIG)).toBe(
      null,
    )
    await expect(
      rpcAccount(answer({ error: { code: -32602, message: 'bad' } }), 'https://r.test', CONFIG),
    ).rejects.toThrow('bad')
  })
})

describe('lookupTarget (GET /markets/{market}, then GET /games/{gameId})', () => {
  const client = (resolutions: Array<{ market: string; gameMarket: string }>) => ({
    markets: { get: async () => ({ gameId: 'nba-401810001' }) },
    games: {
      get: async (id: string) => ({
        id,
        home: 'CLE',
        away: 'MEM',
        resolutions: resolutions as unknown as Resolution[],
      }),
    },
  })

  it('finds the resolution that names the market', async () => {
    const t = await lookupTarget(client([{ market: MARKET, gameMarket: GAME_MARKET }]), MARKET)
    expect(t).toMatchObject({ gameId: 'nba-401810001', away: 'MEM', home: 'CLE' })
    expect(t?.resolution.gameMarket).toBe(GAME_MARKET)
  })

  it('is null when the game holds no resolution for the market', async () => {
    expect(await lookupTarget(client([]), MARKET)).toBeNull()
  })
})
