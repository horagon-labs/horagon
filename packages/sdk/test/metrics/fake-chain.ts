// Fake Horagon chain data for the count-fans tests: GameMarket account bytes, raw getTransaction
// JSON, and a fake JSON-RPC endpoint that serves them. This file encodes with its own code (a
// BigInt base58, Buffer writes, hex discriminators) and never calls the script's decoders, so a
// test cannot pass by checking the script against itself.
import { createHash } from 'node:crypto'
import type { RawTransaction, TeamRole, WalletsFile } from '../../../../scripts/count-fans.mjs'

export const PROGRAMS = {
  horagon: 'HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF',
  pmAmm: 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  legacyMemo: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  system: '11111111111111111111111111111111',
} as const

const hex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'hex'))
export const DISCRIMINATORS = {
  gameMarket: hex('2329288723d8da5a'),
  config: hex('9b0caae01efacc82'),
  swap: hex('f8c69e91e17587c8'),
  redeemPair: hex('9d667dc01f30a572'),
  claimWinnings: hex('a1d7183b0eecf2dd'),
} as const

const DIGITS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58 by BigInt division, a second implementation next to the script's. */
export function toBase58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = DIGITS.charAt(Number(n % 58n)) + out
    n /= 58n
  }
  const zeros = bytes.findIndex((b) => b !== 0)
  return '1'.repeat(zeros === -1 ? bytes.length : zeros) + out
}

export const utf8 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'utf8'))
export const keyBytes = (label: string): Uint8Array =>
  Uint8Array.from(createHash('sha256').update(`key:${label}`).digest())
export const fakeKey = (label: string): string => toBase58(keyBytes(label))
export const fakeSignature = (label: string): string =>
  toBase58(createHash('sha512').update(`sig:${label}`).digest())

export const walletKey = (label: string): string => fakeKey(`wallet/${label}`)
export const gameMarketKey = (label: string): string => fakeKey(`game-market/${label}`)
export const pmAmmMarketKey = (label: string): string => fakeKey(`pm-amm/${label}`)
export const SPONSOR = walletKey('sponsor')

// ---------------------------------------------------------------------------------------------
// GameMarket account data

export interface GameMarketFields {
  /** Label of the pm-AMM market key, written as keyBytes(label). */
  marketLabel: string
  marketId: bigint
  kind: number
  league: string
  gameId: string
  home: string
  away: string
  scheduledTipoff: number
  discriminator?: Uint8Array
}

/** The full 326-byte account, laid out field by field as the Horagon program stores it. */
export function gameMarketData(f: GameMarketFields): Uint8Array {
  const data = Buffer.alloc(326)
  let at = 0
  const put = (bytes: Uint8Array) => {
    data.set(bytes, at)
    at += bytes.length
  }
  const ascii = (text: string, size: number) => {
    const field = Buffer.alloc(size)
    field.write(text, 'ascii')
    return field
  }
  put(f.discriminator ?? DISCRIMINATORS.gameMarket)
  put(keyBytes(f.marketLabel)) // market
  at = data.writeBigUInt64LE(f.marketId, at) // market_id
  at = data.writeUInt8(f.kind, at) // kind
  put(ascii(f.league, 8)) // league
  const id = utf8(f.gameId)
  at = data.writeUInt32LE(id.length, at) // external_game_id
  put(id)
  put(ascii(f.home, 4)) // home
  put(ascii(f.away, 4)) // away
  at = data.writeBigInt64LE(BigInt(f.scheduledTipoff), at) // scheduled_tipoff
  at = data.writeBigInt64LE(BigInt(f.scheduledTipoff + 7_800), at) // end_ts
  at = data.writeBigUInt64LE(1_000_000_000n, at) // seed_amount
  at = data.writeUInt8(0, at) // status: Open
  at = data.writeUInt8(0, at) // proposed_outcome: None
  put(new Uint8Array(32)) // evidence_hash
  data.writeUInt32LE(0, at) // evidence_uri: ''; the rest stays zero
  return Uint8Array.from(data)
}

// ---------------------------------------------------------------------------------------------
// Raw transactions

export interface FakeInstruction {
  program: string
  accounts: string[]
  data: Uint8Array
}

export interface TxInput {
  signature: string
  blockTime: number | null
  /** keys[0..n) of the message, in order; keys[0] pays the fee. */
  signers: string[]
  instructions: FakeInstruction[]
  inner?: { index: number; instructions: FakeInstruction[] }[]
  err?: unknown
  /** Keys resolved through an address lookup table instead of the static key list. */
  loaded?: { writable: string[]; readonly: string[] }
}

/** The `getTransaction` JSON (encoding `json`) of a v0 transaction. */
export function rawTransaction(input: TxInput): RawTransaction {
  const loaded = input.loaded ?? { writable: [], readonly: [] }
  const lookedUp = new Set([...loaded.writable, ...loaded.readonly])
  const inner = input.inner ?? []
  const staticKeys = [...input.signers]
  for (const ix of [...input.instructions, ...inner.flatMap((group) => group.instructions)]) {
    for (const key of [...ix.accounts, ix.program]) {
      if (!staticKeys.includes(key) && !lookedUp.has(key)) staticKeys.push(key)
    }
  }
  const space = [...staticKeys, ...loaded.writable, ...loaded.readonly]
  const compile = (ix: FakeInstruction) => ({
    programIdIndex: space.indexOf(ix.program),
    accounts: ix.accounts.map((key) => space.indexOf(key)),
    data: toBase58(ix.data),
  })
  return {
    slot: 431_000_000,
    blockTime: input.blockTime,
    version: 0,
    meta: {
      err: input.err ?? null,
      loadedAddresses: { writable: [...loaded.writable], readonly: [...loaded.readonly] },
      innerInstructions: inner.map((group) => ({
        index: group.index,
        instructions: group.instructions.map((ix) => ({ ...compile(ix), stackHeight: 2 })),
      })),
    },
    transaction: {
      signatures: input.signers.map((_, i) =>
        i === 0 ? input.signature : fakeSignature(`${input.signature}/${i}`),
      ),
      message: {
        header: {
          numRequiredSignatures: input.signers.length,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        accountKeys: staticKeys,
        instructions: input.instructions.map((ix) => ({ ...compile(ix), stackHeight: null })),
        addressTableLookups:
          lookedUp.size === 0
            ? []
            : [
                {
                  accountKey: fakeKey('lookup-table'),
                  writableIndexes: loaded.writable.map((_, i) => i),
                  readonlyIndexes: loaded.readonly.map((_, i) => loaded.writable.length + i),
                },
              ],
      },
    },
  }
}

export function swapData(direction = 0, amountIn = 5_000_000n, minOutput = 0n): Uint8Array {
  const data = Buffer.alloc(25)
  data.set(DISCRIMINATORS.swap, 0)
  data.writeUInt8(direction, 8)
  data.writeBigUInt64LE(amountIn, 9)
  data.writeBigUInt64LE(minOutput, 17)
  return Uint8Array.from(data)
}

/** A pm-AMM instruction with the swap account layout: trader, market, then ten more accounts. */
export function pmAmmInstruction(wallet: string, market: string, data = swapData()) {
  return {
    program: PROGRAMS.pmAmm,
    accounts: [
      wallet,
      market,
      fakeKey('musdc-mint'),
      fakeKey(`${market}/yes-mint`),
      fakeKey(`${market}/no-mint`),
      fakeKey(`${market}/vault`),
      fakeKey(`${wallet}/usdc`),
      fakeKey(`${wallet}/yes`),
      fakeKey(`${wallet}/no`),
      fakeKey('dao/usdc'),
      fakeKey('authority/usdc'),
      PROGRAMS.token,
    ],
    data,
  }
}

export type MemoKind = 'exact' | 'with-account' | 'wrong-text' | 'legacy-program' | 'inner'

export function memoInstruction(kind: Exclude<MemoKind, 'inner'>, signer: string) {
  return {
    program: kind === 'legacy-program' ? PROGRAMS.legacyMemo : PROGRAMS.memo,
    accounts: kind === 'with-account' ? [signer] : [],
    data: utf8(kind === 'wrong-text' ? 'horagon:bots' : 'horagon:bot'),
  }
}

export interface TradeInput {
  signature: string
  blockTime: number
  /** Signs every swap of the trade: accounts[0] of each swap. */
  wallet: string
  /** pm-AMM market pubkeys, one swap instruction each. */
  markets: string[]
  sponsored?: boolean
  memo?: MemoKind
  /** The transaction fails in its last swap: meta.err is set. */
  failed?: boolean
}

/** A trade as Horagon builds it: compute budget, an idempotent ATA create, the swap(s) last. */
export function tradeTransaction(t: TradeInput): RawTransaction {
  const payer = t.sponsored ? SPONSOR : t.wallet
  const instructions: FakeInstruction[] = [
    { program: PROGRAMS.computeBudget, accounts: [], data: Uint8Array.from([2, 0, 53, 12, 0]) },
    {
      program: PROGRAMS.associatedToken,
      accounts: [
        payer,
        fakeKey(`${t.wallet}/usdc`),
        t.wallet,
        fakeKey('musdc-mint'),
        PROGRAMS.system,
        PROGRAMS.token,
      ],
      data: Uint8Array.from([1]),
    },
  ]
  if (t.memo !== undefined && t.memo !== 'inner') {
    instructions.push(memoInstruction(t.memo, t.wallet))
  }
  const firstSwap = instructions.length
  for (const market of t.markets) instructions.push(pmAmmInstruction(t.wallet, market))
  return rawTransaction({
    signature: t.signature,
    blockTime: t.blockTime,
    signers: t.sponsored ? [SPONSOR, t.wallet] : [t.wallet],
    instructions,
    err: t.failed ? { InstructionError: [instructions.length - 1, { Custom: 6004 }] } : null,
    inner:
      t.memo === 'inner'
        ? [{ index: firstSwap, instructions: [memoInstruction('exact', t.wallet)] }]
        : [],
  })
}

// ---------------------------------------------------------------------------------------------
// Seasons: the compact scenario form of tests/fixtures/metrics/*.json

export interface SeasonMarket {
  label: string
  kind: number
  league: string
  game: string
  /** ISO 8601 with an explicit offset. */
  tipoff: string
}

export interface SwapOptions {
  memo?: MemoKind
  sponsored?: boolean
  /** This many swaps, `every` seconds apart, each in its own transaction. */
  repeat?: number
  every?: number
  /** Swaps with the same label share one transaction (wallet, time and options of the first). */
  tx?: string
  /** The transaction fails: meta.err is set, and getSignaturesForAddress still lists it. */
  failed?: boolean
}

export type SeasonSwap = [wallet: string, market: string, at: string, options?: SwapOptions]

export interface Season {
  team?: { wallet: string; role: TeamRole }[]
  excluded?: { market: string; reason: string }[]
  markets: SeasonMarket[]
  swaps: SeasonSwap[]
}

export interface FakeChain {
  /** Horagon GameMarket accounts, as getProgramAccounts would return them. */
  accounts: { address: string; data: Uint8Array }[]
  transactions: RawTransaction[]
  wallets: WalletsFile
}

const unix = (iso: string): number => Date.parse(iso) / 1000

export function seasonChain(season: Season): FakeChain {
  const accounts = season.markets.map((m, i) => ({
    address: gameMarketKey(m.label),
    data: gameMarketData({
      marketLabel: `pm-amm/${m.label}`,
      marketId: BigInt(i + 1),
      kind: m.kind,
      league: m.league,
      gameId: m.game,
      home: 'HOM',
      away: 'AWY',
      scheduledTipoff: unix(m.tipoff),
    }),
  }))
  const trades = new Map<string, TradeInput>()
  for (const [wallet, market, at, options = {}] of season.swaps) {
    for (let k = 0; k < (options.repeat ?? 1); k++) {
      const label = options.tx ?? `swap-${trades.size}`
      const trade = trades.get(label)
      if (trade !== undefined) {
        trade.markets.push(pmAmmMarketKey(market))
        continue
      }
      trades.set(label, {
        signature: fakeSignature(label),
        blockTime: unix(at) + k * (options.every ?? 0),
        wallet: walletKey(wallet),
        markets: [pmAmmMarketKey(market)],
        sponsored: options.sponsored,
        memo: options.memo,
        failed: options.failed,
      })
    }
  }
  return {
    accounts,
    transactions: [...trades.values()].map(tradeTransaction),
    wallets: {
      version: 1,
      teamWallets: (season.team ?? []).map((t) => ({
        pubkey: walletKey(t.wallet),
        role: t.role,
        addedAt: '2026-11-22',
      })),
      excludedMarkets: (season.excluded ?? []).map((e) => ({
        gameMarket: gameMarketKey(e.market),
        reason: e.reason,
        createSignature: fakeSignature(`create/${e.market}`),
        addedAt: '2026-11-22T09:00:00Z',
      })),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// A fake JSON-RPC endpoint over fake chain data, for the RPC and CLI tests

/** Base58 to bytes by BigInt, for the memcmp filter of getProgramAccounts. */
function fromBase58(text: string): Uint8Array {
  let n = 0n
  for (const c of text) {
    const digit = DIGITS.indexOf(c)
    if (digit < 0) throw new Error(`not base58: ${text}`)
    n = n * 58n + BigInt(digit)
  }
  const bytes: number[] = []
  for (; n > 0n; n /= 256n) bytes.unshift(Number(n % 256n))
  const zeros = text.length - text.replace(/^1+/, '').length
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes])
}

export interface FakeClock {
  /** Milliseconds, like Date.now. */
  now: () => number
  /** Moves the clock forward at once instead of waiting. */
  sleep: (ms: number) => Promise<void>
  /** Every sleep, in order. */
  sleeps: number[]
}

/** A clock that moves only when the code under test sleeps. It suits one caller at a time. */
export function fakeClock(start = 0): FakeClock {
  let time = start
  const sleeps: number[] = []
  return {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms)
      time += ms
    },
    sleeps,
  }
}

export interface RpcRequest {
  url: string
  method: string
  params: unknown[]
  /** The fake clock's time when the request arrived, 0 without a clock. */
  at: number
}

/** One entry of a getSignaturesForAddress page. */
export interface SignatureInfo {
  signature: string
  slot: number
  err: unknown
  memo: string | null
  blockTime: number | null
  confirmationStatus: 'confirmed'
}

export interface FakeRpc {
  fetch: typeof fetch
  /** Every request received, in order. */
  requests: RpcRequest[]
  /** Every transaction that holds the address, newest first: all the pages in one list. */
  signaturesFor(address: string): SignatureInfo[]
}

type RpcReply = { result: unknown } | { error: { code: number; message: string } }
const rpcError = (code: number, message: string): RpcReply => ({ error: { code, message } })

interface AccountFilter {
  memcmp?: { offset: number; bytes: string; encoding?: 'base58' | 'base64' }
  dataSize?: number
}

function passes(filter: AccountFilter, data: Uint8Array): boolean {
  if (filter.dataSize !== undefined) return data.length === filter.dataSize
  const memcmp = filter.memcmp
  if (memcmp === undefined) throw new Error(`unknown filter ${JSON.stringify(filter)}`)
  const bytes =
    memcmp.encoding === 'base64' ? Buffer.from(memcmp.bytes, 'base64') : fromBase58(memcmp.bytes)
  return bytes.every((b, i) => data[memcmp.offset + i] === b)
}

/**
 * Serves getProgramAccounts, getSignaturesForAddress and getTransaction over `chain` the way a
 * Solana RPC node does: account data in base64 after the filters; signature pages of at most
 * 1,000, newest first, continued with `before`, failed transactions included with their `err`;
 * null for an unknown signature; error -32015 for a v0 transaction asked for without
 * maxSupportedTransactionVersion 0.
 */
export function fakeRpc(
  chain: Pick<FakeChain, 'accounts' | 'transactions'>,
  clock?: FakeClock,
): FakeRpc {
  const requests: RpcRequest[] = []
  const bySignature = new Map<string, RawTransaction>()
  const byAddress = new Map<string, SignatureInfo[]>()
  // Newest first: the later block time first and, on a tie, the transaction listed later.
  const newestFirst = chain.transactions
    .map((tx, i) => ({ tx, i }))
    .sort((a, b) => (b.tx.blockTime ?? 0) - (a.tx.blockTime ?? 0) || b.i - a.i)
  for (const { tx } of newestFirst) {
    const signature = tx.transaction.signatures[0]
    if (signature === undefined) throw new Error('a transaction without a signature')
    bySignature.set(signature, tx)
    const info: SignatureInfo = {
      signature,
      slot: tx.slot ?? 0,
      err: tx.meta?.err ?? null,
      memo: null,
      blockTime: tx.blockTime,
      confirmationStatus: 'confirmed',
    }
    const loaded = tx.meta?.loadedAddresses
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(loaded?.writable ?? []),
      ...(loaded?.readonly ?? []),
    ]
    for (const key of new Set(keys)) byAddress.set(key, [...(byAddress.get(key) ?? []), info])
  }

  function reply(method: string, params: unknown[]): RpcReply {
    if (method === 'getProgramAccounts') {
      const [program, config] = params as [
        string,
        { encoding?: string; filters?: AccountFilter[] }?,
      ]
      if (config?.encoding !== 'base64') return rpcError(-32602, 'the fake serves base64 only')
      const owned = program === PROGRAMS.horagon ? chain.accounts : []
      return {
        result: owned
          .filter(({ data }) => (config.filters ?? []).every((filter) => passes(filter, data)))
          .map(({ address, data }) => ({
            pubkey: address,
            account: {
              data: [Buffer.from(data).toString('base64'), 'base64'],
              executable: false,
              lamports: 3_160_080,
              owner: PROGRAMS.horagon,
              rentEpoch: 0,
              space: data.length,
            },
          })),
      }
    }
    if (method === 'getSignaturesForAddress') {
      const [address, config = {}] = params as [string, { limit?: number; before?: string }?]
      const all = byAddress.get(address) ?? []
      const from =
        config.before === undefined ? 0 : all.findIndex((s) => s.signature === config.before) + 1
      if (config.before !== undefined && from === 0) return rpcError(-32602, 'unknown before')
      return { result: all.slice(from, from + Math.min(config.limit ?? 1000, 1000)) }
    }
    if (method === 'getTransaction') {
      const [signature, config = {}] = params as [
        string,
        { encoding?: string; maxSupportedTransactionVersion?: number }?,
      ]
      const tx = bySignature.get(signature)
      if (tx === undefined) return { result: null }
      if (config.encoding !== 'json') return rpcError(-32602, 'the fake serves encoding json only')
      if (tx.version === 0 && config.maxSupportedTransactionVersion !== 0) {
        return rpcError(-32015, 'Transaction version (0) is not supported by the requesting client')
      }
      return { result: tx }
    }
    return rpcError(-32601, 'Method not found')
  }

  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      jsonrpc?: string
      id?: unknown
      method: string
      params?: unknown[]
    }
    const params = body.params ?? []
    requests.push({ url: String(input), method: body.method, params, at: clock?.now() ?? 0 })
    const json = new Headers(init?.headers).get('content-type') === 'application/json'
    if (init?.method !== 'POST' || !json || body.jsonrpc !== '2.0' || body.id === undefined) {
      return new Response('not a JSON-RPC 2.0 request', { status: 400 })
    }
    const payload = { jsonrpc: '2.0', ...reply(body.method, params), id: body.id }
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    })
  }

  return {
    fetch: serve,
    requests,
    signaturesFor: (address) => [...(byAddress.get(address) ?? [])],
  }
}
