#!/usr/bin/env node
// Counts Horagon's 3-Night Fans from public devnet data and the committed wallets file, by the
// rules pre-registered in docs/metrics.md. Read-only: it sends no transaction, holds no key, and
// needs no install or build. Node 22 or later.
//
//   node scripts/count-fans.mjs [--rpc <url>] [--wallets <path>] [--json]
//   node scripts/count-fans.mjs --check-wallets [--wallets <path>] [--previous <path>]
//
// Every counting function is pure and exported. packages/sdk/test/metrics/ tests them, and
// scripts/count-fans.d.mts declares their types.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const HORAGON_PROGRAM_ID = 'HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF'
export const PM_AMM_PROGRAM_ID = 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y'
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const GAME_MARKET_DISCRIMINATOR = Uint8Array.from([35, 41, 40, 135, 35, 216, 218, 90])
export const SWAP_DISCRIMINATOR = Uint8Array.from([248, 198, 158, 145, 225, 117, 135, 200])
export const BOT_MEMO = 'horagon:bot'
export const WINDOW = Object.freeze({ first: '2026-11-23', last: '2026-12-04' })
export const BOT_RATE = Object.freeze({ swaps: 20, seconds: 300 })
export const DEFAULT_RPC = 'https://api.devnet.solana.com'

const CLASSES = ['human', 'bot', 'team']
const TEAM_ROLES = new Set([
  'deployer',
  'creator',
  'sponsor',
  'attestor',
  'guardian-1',
  'guardian-2',
  'treasury',
  'squads-member',
  'team-burner',
  'spike',
])
const BOT_MEMO_BYTES = new TextEncoder().encode(BOT_MEMO)

// ---------------------------------------------------------------------------------------------
// Base58

const B58_DIGITS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_VALUES = new Map([...B58_DIGITS].map((digit, value) => [digit, value]))

export function base58Encode(bytes) {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const digits = [] // base58 digits, least significant first
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256
      digits[j] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  const text = digits.reverse().map((d) => B58_DIGITS[d])
  return '1'.repeat(zeros) + text.join('')
}

export function base58Decode(text) {
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++
  const bytes = [] // least significant first
  for (let i = zeros; i < text.length; i++) {
    const value = B58_VALUES.get(text[i])
    if (value === undefined) throw new Error(`invalid base58 character at position ${i}`)
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry % 256
      carry = Math.floor(carry / 256)
    }
    while (carry > 0) {
      bytes.push(carry % 256)
      carry = Math.floor(carry / 256)
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  out.set(bytes.reverse(), zeros)
  return out
}

const startsWith = (bytes, prefix) =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b)
const sameBytes = (a, b) => a.length === b.length && startsWith(a, b)

// ---------------------------------------------------------------------------------------------
// GameMarket accounts

// Absolute offsets: discriminator 0..8, market 8..40, market_id 40..48, kind 48, league 49..57,
// external_game_id length 57..61, then the id, home [u8;4], away [u8;4], scheduled_tipoff i64.
const GAME_ID_AT = 61

export function decodeGameMarket(data) {
  if (data.length < GAME_ID_AT) throw new Error(`GameMarket data too short: ${data.length} bytes`)
  if (!startsWith(data, GAME_MARKET_DISCRIMINATOR)) {
    throw new Error('not a GameMarket account: wrong discriminator')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const idLength = view.getUint32(57, true)
  const tipoffAt = GAME_ID_AT + idLength + 8
  if (data.length < tipoffAt + 8) throw new Error(`GameMarket data too short: ${data.length} bytes`)
  const league = data.subarray(49, 57)
  const leagueEnd = league.indexOf(0)
  return {
    market: base58Encode(data.subarray(8, 40)),
    kind: data[48],
    league: String.fromCharCode(...(leagueEnd < 0 ? league : league.subarray(0, leagueEnd))),
    gameId: new TextDecoder().decode(data.subarray(GAME_ID_AT, GAME_ID_AT + idLength)),
    scheduledTipoff: Number(view.getBigInt64(tipoffAt, true)),
  }
}

// ---------------------------------------------------------------------------------------------
// Nights (ET dates)

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function etNight(unixSeconds) {
  const parts = {}
  for (const { type, value } of ET_PARTS.formatToParts(new Date(unixSeconds * 1000))) {
    parts[type] = value
  }
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function inWindow(night) {
  return /^\d{4}-\d{2}-\d{2}$/.test(night) && night >= WINDOW.first && night <= WINDOW.last
}

function windowNights() {
  const nights = []
  for (let at = Date.parse(`${WINDOW.first}T12:00:00Z`); ; at += 86_400_000) {
    const night = new Date(at).toISOString().slice(0, 10)
    if (night > WINDOW.last) return nights
    nights.push(night)
  }
}

// ---------------------------------------------------------------------------------------------
// Transactions (raw getTransaction JSON, encoding `json`)

// The account index space of a v0 message: static keys, then loaded writable, then loaded readonly.
function accountKeys(tx) {
  const loaded = tx.meta?.loadedAddresses
  return [
    ...tx.transaction.message.accountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ]
}

export function hasBotMemo(tx) {
  const keys = accountKeys(tx)
  return tx.transaction.message.instructions.some(
    (ix) =>
      keys[ix.programIdIndex] === MEMO_PROGRAM_ID &&
      ix.accounts.length === 0 &&
      sameBytes(base58Decode(ix.data), BOT_MEMO_BYTES),
  )
}

// Top-level pm-AMM swaps of a successful transaction on one of `markets` (pm-AMM market pubkeys).
// Swaps reached through a CPI live in meta.innerInstructions and are never read.
export function extractSwaps(tx, markets) {
  if (!tx.meta || tx.meta.err !== null || typeof tx.blockTime !== 'number') return []
  const { message, signatures } = tx.transaction
  const keys = accountKeys(tx)
  const botMemo = hasBotMemo(tx)
  const swaps = []
  for (const ix of message.instructions) {
    if (keys[ix.programIdIndex] !== PM_AMM_PROGRAM_ID) continue
    const [walletIndex, marketIndex] = ix.accounts
    if (walletIndex === undefined || marketIndex === undefined) continue
    if (walletIndex >= message.header.numRequiredSignatures) continue
    const market = keys[marketIndex]
    if (market === undefined || !markets.has(market)) continue
    if (!startsWith(base58Decode(ix.data), SWAP_DISCRIMINATOR)) continue
    swaps.push({
      signature: signatures[0],
      wallet: keys[walletIndex],
      market,
      blockTime: tx.blockTime,
      botMemo,
    })
  }
  return swaps
}

// ---------------------------------------------------------------------------------------------
// Wallets file (docs/metrics-wallets.json)

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isBase58Of = (value, length) => {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return base58Decode(value).length === length
  } catch {
    return false
  }
}
const isOneLine = (value) =>
  typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value)
// A UTC date, '2026-11-22', or a UTC date-time, '2026-11-22T10:00:00Z'. Milliseconds and other
// offsets are rejected, so `new Date().toISOString()` output is too.
const isUtcDate = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString().slice(0, 10) === value.slice(0, 10)
const NOT_UTC_DATE = 'not a UTC date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)'

function unknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}: unknown field "${key}"`)
  }
}

export function validateWalletsFile(json) {
  const errors = []
  if (!isRecord(json)) return { ok: false, errors: ['the wallets file is not a JSON object'] }
  unknownKeys(json, ['version', 'teamWallets', 'excludedMarkets'], 'root', errors)
  if (json.version !== 1) errors.push('version: must be 1')
  if (!Array.isArray(json.teamWallets)) errors.push('teamWallets: must be an array')
  if (!Array.isArray(json.excludedMarkets)) errors.push('excludedMarkets: must be an array')
  const teamWallets = Array.isArray(json.teamWallets) ? json.teamWallets : []
  const excludedMarkets = Array.isArray(json.excludedMarkets) ? json.excludedMarkets : []
  const pubkeys = new Set()
  for (const [i, entry] of teamWallets.entries()) {
    const path = `teamWallets[${i}]`
    if (!isRecord(entry)) {
      errors.push(`${path}: must be an object`)
      continue
    }
    unknownKeys(entry, ['pubkey', 'role', 'addedAt'], path, errors)
    if (!isBase58Of(entry.pubkey, 32)) errors.push(`${path}.pubkey: not a base58 pubkey`)
    else if (pubkeys.has(entry.pubkey)) errors.push(`${path}.pubkey: listed twice`)
    else pubkeys.add(entry.pubkey)
    if (!TEAM_ROLES.has(entry.role)) errors.push(`${path}.role: unknown role`)
    if (!isUtcDate(entry.addedAt)) errors.push(`${path}.addedAt: ${NOT_UTC_DATE}`)
  }
  const gameMarkets = new Set()
  for (const [i, entry] of excludedMarkets.entries()) {
    const path = `excludedMarkets[${i}]`
    if (!isRecord(entry)) {
      errors.push(`${path}: must be an object`)
      continue
    }
    unknownKeys(entry, ['gameMarket', 'reason', 'createSignature', 'addedAt'], path, errors)
    if (!isBase58Of(entry.gameMarket, 32)) errors.push(`${path}.gameMarket: not a base58 pubkey`)
    else if (gameMarkets.has(entry.gameMarket)) errors.push(`${path}.gameMarket: listed twice`)
    else gameMarkets.add(entry.gameMarket)
    if (!isOneLine(entry.reason)) errors.push(`${path}.reason: must be one non-empty line`)
    if (!isBase58Of(entry.createSignature, 64)) {
      errors.push(`${path}.createSignature: not a base58 signature`)
    }
    if (!isUtcDate(entry.addedAt)) errors.push(`${path}.addedAt: ${NOT_UTC_DATE}`)
  }
  return errors.length === 0 ? { ok: true, value: json } : { ok: false, errors }
}

// Entries are never removed, changed or reordered: `next` may only append to each list.
export function checkAppendOnly(previous, next) {
  const errors = []
  const fields = {
    teamWallets: ['pubkey', 'role', 'addedAt'],
    excludedMarkets: ['gameMarket', 'reason', 'createSignature', 'addedAt'],
  }
  for (const [list, keys] of Object.entries(fields)) {
    for (const [i, before] of previous[list].entries()) {
      const after = next[list][i]
      if (after === undefined) errors.push(`${list}[${i}]: removed`)
      else if (keys.some((key) => before[key] !== after[key])) errors.push(`${list}[${i}]: changed`)
    }
  }
  return errors
}

// ---------------------------------------------------------------------------------------------
// Counting

export function isRateBot(blockTimes) {
  const times = [...blockTimes].sort((a, b) => a - b)
  const span = BOT_RATE.swaps - 1
  for (let i = 0; i + span < times.length; i++) {
    if (times[i + span] - times[i] < BOT_RATE.seconds) return true
  }
  return false
}

// 'excluded' when listed in excludedMarkets (whatever its kind or league), 'counted' when an NBA
// game market of kind 0 or 2, 'ignored' otherwise (kind 1, PRACTICE, any other league).
function marketClass(record, excludedAddresses) {
  if (excludedAddresses.has(record.address)) return 'excluded'
  if (record.league === 'NBA' && (record.kind === 0 || record.kind === 2)) return 'counted'
  return 'ignored'
}

const emptyStats = () => ({
  wallets: 0,
  firstTrade: 0,
  returning: 0,
  threeNightFans: 0,
  engaged: 0,
})

export function countFans({ markets, swaps, wallets }) {
  const team = new Set(wallets.teamWallets.map((w) => w.pubkey))
  const excludedAddresses = new Set(wallets.excludedMarkets.map((e) => e.gameMarket))
  const tally = { counted: 0, excluded: 0, ignored: 0 }
  const counted = new Map() // pm-AMM market -> { night, game }
  const excluded = new Map() // pm-AMM market -> { address, nonTeamSwaps }
  for (const record of markets) {
    const which = marketClass(record, excludedAddresses)
    tally[which]++
    if (which === 'counted') {
      const game = `${record.league}\u0000${record.gameId}` // kind 0 and kind 2 share it
      counted.set(record.market, { night: etNight(record.scheduledTipoff), game })
    }
    if (which === 'excluded') {
      excluded.set(record.market, { address: record.address, nonTeamSwaps: 0 })
    }
  }

  const perWallet = new Map()
  let countedSwaps = 0
  let nightTouches = 0
  for (const swap of swaps) {
    const onExcluded = excluded.get(swap.market)
    if (onExcluded !== undefined) {
      if (!team.has(swap.wallet)) onExcluded.nonTeamSwaps++
      continue // counted nowhere else
    }
    const market = counted.get(swap.market)
    if (market === undefined) continue
    countedSwaps++
    let w = perWallet.get(swap.wallet)
    if (w === undefined) {
      w = {
        times: [],
        memo: false,
        nights: new Set(),
        games: new Set(),
        touches: 0,
        touchesByNight: new Map(), // night -> night touches of this wallet on that night
      }
      perWallet.set(swap.wallet, w)
    }
    w.times.push(swap.blockTime)
    if (swap.botMemo) w.memo = true
    if (!inWindow(market.night)) continue
    nightTouches++
    w.touches++
    w.nights.add(market.night)
    w.games.add(market.game)
    w.touchesByNight.set(market.night, (w.touchesByNight.get(market.night) ?? 0) + 1)
  }

  const classes = { human: emptyStats(), bot: emptyStats(), team: emptyStats() }
  const bots = { memo: 0, rate: 0 }
  // Per night and class: the wallets with a night touch, and the night touches (swaps).
  const nights = windowNights().map((night) => ({
    night,
    human: 0,
    bot: 0,
    team: 0,
    touches: { human: 0, bot: 0, team: 0 },
  }))
  const nightRow = new Map(nights.map((row) => [row.night, row]))
  for (const [wallet, w] of perWallet) {
    let walletClass = 'human'
    if (team.has(wallet)) walletClass = 'team'
    else {
      const rate = isRateBot(w.times)
      if (w.memo) bots.memo++
      if (rate) bots.rate++
      if (w.memo || rate) walletClass = 'bot'
    }
    const stats = classes[walletClass]
    stats.wallets++
    if (w.nights.size >= 1) stats.firstTrade++
    if (w.nights.size >= 2) stats.returning++
    if (w.nights.size >= 3) stats.threeNightFans++
    if (w.touches >= 3 && w.games.size >= 2) stats.engaged++
    for (const night of w.nights) nightRow.get(night)[walletClass]++
    for (const [night, n] of w.touchesByNight) nightRow.get(night).touches[walletClass] += n
  }

  const nonTeamSwaps = new Map([...excluded.values()].map((e) => [e.address, e.nonTeamSwaps]))
  return {
    window: { first: WINDOW.first, last: WINDOW.last },
    markets: tally,
    swaps: { counted: countedSwaps, nightTouches },
    classes,
    bots,
    nights,
    excluded: wallets.excludedMarkets.map((e) => ({
      gameMarket: e.gameMarket,
      reason: e.reason,
      nonTeamSwaps: nonTeamSwaps.get(e.gameMarket) ?? 0,
    })),
    threeNightFans: classes.human.threeNightFans,
  }
}

// Columns: the first is left-aligned, the others right-aligned, two spaces apart.
function table(header, rows) {
  const lines = [header, ...rows.map((cells) => cells.map(String))]
  const widths = header.map((_, i) => Math.max(...lines.map((cells) => cells[i].length)))
  return lines.map((cells) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join('  '),
  )
}

export function formatReport(report, meta) {
  const { markets, swaps, classes, bots } = report
  // A wallets-file entry whose GameMarket is not on chain is listed but not found, so the
  // `excluded` count of `markets` can be lower than the number of entries.
  const listed = report.excluded.length
  return [
    'Horagon 3-Night Fans (scripts/count-fans.mjs)',
    `rpc: ${meta.rpc}`,
    `window: ET nights ${report.window.first} to ${report.window.last}`,
    `markets: ${markets.counted} counted, ${markets.excluded} excluded, ${markets.ignored} ignored`,
    `swaps: ${swaps.counted} on counted markets, ${swaps.nightTouches} night touches`,
    '',
    `3-Night Fans (human wallets): ${report.threeNightFans}`,
    '',
    ...table(
      ['class', 'wallets', 'first-trade', 'returning', '3-night', 'engaged'],
      CLASSES.map((c) => [
        c,
        classes[c].wallets,
        classes[c].firstTrade,
        classes[c].returning,
        classes[c].threeNightFans,
        classes[c].engaged,
      ]),
    ),
    `bot wallets by reason: memo ${bots.memo}, rate ${bots.rate}`,
    '',
    'per ET night: wallets with a night touch, then night touches',
    ...table(
      ['night (ET)', 'human', 'bot', 'team', 'human touches', 'bot touches', 'team touches'],
      report.nights.map((r) => [
        r.night,
        r.human,
        r.bot,
        r.team,
        r.touches.human,
        r.touches.bot,
        r.touches.team,
      ]),
    ),
    '',
    `excluded markets: ${listed} listed in the wallets file, ${markets.excluded} on chain`,
    ...report.excluded.map(
      (e) => `  ${e.gameMarket}  non-team swaps: ${e.nonTeamSwaps}  reason: ${e.reason}`,
    ),
    '',
    `elapsed: ${(meta.elapsedMs / 1000).toFixed(1)} s`,
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// RPC

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
const NULL_RETRIES = 3
const REQUEST_TIMEOUT_MS = 30_000
const PAGE_LIMIT = 1000

// Waits of 500 ms, 1 s, 2 s, 4 s, then 8 s: `retry` counts the retries already made.
const backoffMs = (retry) => Math.min(8_000, 500 * 2 ** retry)

// A getTransaction result that can be counted: an object whose meta is an object with an err key
// (null or not) and whose blockTime is a number. Real nodes always send both. Anything else, null
// included, is not available yet: extractSwaps would drop it silently.
const isFullTransaction = (tx) =>
  isRecord(tx) &&
  isRecord(tx.meta) &&
  Object.hasOwn(tx.meta, 'err') &&
  typeof tx.blockTime === 'number'

// Retry-After holds delay-seconds or an HTTP-date. undefined when it is absent or unreadable.
function retryAfterMs(header, nowMs) {
  const text = header?.trim() ?? ''
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const at = /[a-z]/i.test(text) ? Date.parse(text) : Number.NaN
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined
}

const describeError = (error) =>
  error?.cause?.code === undefined
    ? String(error?.message ?? error)
    : `${error.message} (${error.cause.code})`

// The parsed body, or undefined when it is not JSON.
function parseBody(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// The error of a JSON-RPC error body, naming the method and the code; undefined for other bodies.
function jsonRpcError(method, body) {
  if (!isRecord(body) || !isRecord(body.error)) return undefined
  return new Error(`${method} failed: JSON-RPC error ${body.error.code}: ${body.error.message}`)
}

function readResult(method, text) {
  const body = parseBody(text)
  if (body === undefined) throw new Error(`${method} failed: the response is not JSON`)
  const error = jsonRpcError(method, body)
  if (error !== undefined) throw error
  if (!isRecord(body) || !('result' in body)) {
    throw new Error(`${method} failed: the response has no result`)
  }
  return body.result
}

export function createRpc(url, options = {}) {
  const {
    fetch: send = globalThis.fetch,
    ratePerSecond = 4,
    maxRetries = 8,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    onRetry = () => {},
  } = options
  const interval = 1000 / ratePerSecond
  let nextStart = Number.NEGATIVE_INFINITY
  let calls = 0
  let lastId = 0

  // A token bucket that gains ratePerSecond tokens a second and holds one: every request, a retry
  // included, starts at least 1000 / ratePerSecond ms after the one before, so no second holds
  // more than ratePerSecond requests. The start is booked before the wait, so calls made at the
  // same time queue up instead of sharing a token.
  async function takeToken() {
    const start = Math.max(now(), nextStart)
    nextStart = start + interval
    const wait = start - now()
    if (wait > 0) await sleep(wait)
  }

  // One HTTP request. A network error, or a body that cannot be read, gives a string status.
  async function post(method, params) {
    await takeToken()
    calls++
    try {
      const response = await send(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++lastId, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const text = await response.text()
      const retryAfter = response.headers.get('retry-after')
      return { ok: response.ok, status: response.status, retryAfter, text }
    } catch (error) {
      return { ok: false, status: describeError(error), retryAfter: null, text: '' }
    }
  }

  // The `result` of one JSON-RPC call, retried on HTTP 429, 500, 502, 503, 504 and network errors.
  async function request(method, params) {
    for (let retry = 0; ; retry++) {
      const { ok, status, retryAfter, text } = await post(method, params)
      if (ok) return readResult(method, text)
      if (typeof status === 'number' && !RETRY_STATUSES.has(status)) {
        // Some nodes send a JSON-RPC error with an HTTP error status, such as 401: name its code.
        throw jsonRpcError(method, parseBody(text)) ?? new Error(`${method} failed: HTTP ${status}`)
      }
      if (retry === maxRetries) {
        throw new Error(`${method} failed after ${maxRetries} retries (${status})`)
      }
      const waitMs = retryAfterMs(retryAfter, now()) ?? backoffMs(retry)
      onRetry({ method, attempt: retry + 1, waitMs, status })
      await sleep(waitMs)
    }
  }

  async function call(method, params) {
    for (let retry = 0; ; retry++) {
      const result = await request(method, params)
      if (method !== 'getTransaction' || isFullTransaction(result)) return result
      // A node that lags behind answers null, or a transaction without meta, meta.err or
      // blockTime, for a transaction it will have in full soon. Each is retried like null, then
      // the count stops: a listed signature is never dropped.
      if (retry === NULL_RETRIES) throw new Error(`transaction ${params[0]} not available`)
      const waitMs = backoffMs(retry)
      onRetry({ method, attempt: retry + 1, waitMs, status: 'null' })
      await sleep(waitMs)
    }
  }

  return {
    call,
    get calls() {
      return calls
    },
  }
}

export async function fetchGameMarkets(rpc) {
  const accounts = await rpc.call('getProgramAccounts', [
    HORAGON_PROGRAM_ID,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: base58Encode(GAME_MARKET_DISCRIMINATOR) } }],
    },
  ])
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    ...decodeGameMarket(Buffer.from(account.data[0], 'base64')),
  }))
}

// Successful transactions only, newest first, over every page.
export async function fetchSignatures(rpc, address) {
  const signatures = []
  let before
  for (;;) {
    const page = await rpc.call('getSignaturesForAddress', [
      address,
      { limit: PAGE_LIMIT, ...(before === undefined ? {} : { before }), commitment: 'confirmed' },
    ])
    for (const entry of page) if (entry.err === null) signatures.push(entry.signature)
    if (page.length < PAGE_LIMIT) return signatures
    // The next page starts after the last entry of this one, failed or not.
    before = page[page.length - 1].signature
  }
}

export async function fetchSwaps(rpc, markets, onProgress = () => {}) {
  const pmAmmMarkets = new Set(markets.map((m) => m.market))
  // A transaction on two markets is listed under both: fetch each signature once.
  const signatures = new Set()
  for (const market of pmAmmMarkets) {
    for (const signature of await fetchSignatures(rpc, market)) signatures.add(signature)
  }
  const swaps = []
  let done = 0
  onProgress(done, signatures.size)
  for (const signature of signatures) {
    const tx = await rpc.call('getTransaction', [
      signature,
      { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ])
    swaps.push(...extractSwaps(tx, pmAmmMarkets))
    onProgress(++done, signatures.size)
  }
  return swaps
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = [
  'usage: node scripts/count-fans.mjs [--rpc <url>] [--wallets <path>] [--json]',
  '       node scripts/count-fans.mjs --check-wallets [--wallets <path>] [--previous <path>]',
].join('\n')
const DEFAULT_WALLETS = fileURLToPath(new URL('../docs/metrics-wallets.json', import.meta.url))
const CLI_OPTIONS = {
  rpc: { type: 'string' },
  wallets: { type: 'string' },
  json: { type: 'boolean' },
  'check-wallets': { type: 'boolean' },
  previous: { type: 'string' },
}

const isHttpUrl = (text) => URL.canParse(text) && /^https?:$/.test(new URL(text).protocol)
const hasCredentials = (text) => {
  const { username, password } = new URL(text)
  return username !== '' || password !== ''
}

// { values } or { error }.
function parseCli(argv) {
  try {
    const { values } = parseArgs({ args: [...argv], options: CLI_OPTIONS, strict: true })
    if (values['check-wallets'] && (values.rpc !== undefined || values.json)) {
      return { error: '--check-wallets reads only the wallets files: drop --rpc and --json' }
    }
    if (!values['check-wallets'] && values.previous !== undefined) {
      return { error: '--previous goes with --check-wallets' }
    }
    if (values.rpc !== undefined && !isHttpUrl(values.rpc)) {
      return { error: '--rpc needs an http or https URL' }
    }
    // fetch refuses such a URL, and its error message would print the whole URL, key included.
    if (values.rpc !== undefined && hasCredentials(values.rpc)) {
      return { error: '--rpc must not contain a user name or password' }
    }
    return { values }
  } catch (error) {
    return { error: error.message }
  }
}

// { json } or { error }; `missing` is set when the file cannot be read at all.
function readJson(readFile, path) {
  let text
  try {
    text = readFile(path)
  } catch (error) {
    return { missing: true, error: `cannot read ${path} (${error.code ?? error.message})` }
  }
  try {
    return { json: JSON.parse(text) }
  } catch (error) {
    return { error: `${path} is not valid JSON (${error.message})` }
  }
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text))
  const stderr = io.stderr ?? ((text) => process.stderr.write(text))
  const now = io.now ?? Date.now
  const readFile = io.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const started = now()
  const fail = (code, lines) => {
    stderr(lines.map((line) => `count-fans: ${line}\n`).join(''))
    return code
  }

  const cli = parseCli(argv)
  if (cli.error !== undefined) {
    stderr(`count-fans: ${cli.error}\n${USAGE}\n`)
    return 2
  }
  const options = cli.values
  const walletsPath = options.wallets ?? DEFAULT_WALLETS
  const file = readJson(readFile, walletsPath)
  if (file.missing) return fail(2, [file.error])

  if (options['check-wallets']) {
    // The wallets file is under check, so its faults fail the check (1). The previous file is the
    // reference, so a fault in it is a config error (2).
    const checked =
      file.error === undefined
        ? validateWalletsFile(file.json)
        : { ok: false, errors: [file.error] }
    const errors = checked.ok ? [] : [...checked.errors]
    if (options.previous !== undefined) {
      const reference = readJson(readFile, options.previous)
      if (reference.error !== undefined) return fail(2, [reference.error])
      const previous = validateWalletsFile(reference.json)
      if (!previous.ok) {
        return fail(2, [`${options.previous} is not a valid wallets file:`, ...previous.errors])
      }
      if (checked.ok) errors.push(...checkAppendOnly(previous.value, checked.value))
    }
    stdout(errors.length === 0 ? 'wallets file ok\n' : errors.map((e) => `${e}\n`).join(''))
    return errors.length === 0 ? 0 : 1
  }

  if (file.error !== undefined) return fail(2, [file.error])
  const checked = validateWalletsFile(file.json)
  if (!checked.ok) {
    return fail(2, [`${walletsPath} is not a valid wallets file:`, ...checked.errors])
  }
  const wallets = checked.value
  const rpcUrl = options.rpc ?? DEFAULT_RPC
  // The report shows only the origin, so a key in the path or query of an RPC URL stays private.
  const rpcShown = new URL(rpcUrl).origin
  const rpc = createRpc(rpcUrl, {
    fetch: io.fetch,
    now: io.now,
    sleep: io.sleep,
    onRetry: ({ method, attempt, waitMs, status }) => {
      const seconds = (waitMs / 1000).toFixed(1)
      stderr(`count-fans: ${method}: ${status}, retry ${attempt} in ${seconds} s\n`)
    },
  })
  try {
    const markets = await fetchGameMarkets(rpc)
    const excludedAddresses = new Set(wallets.excludedMarkets.map((e) => e.gameMarket))
    const read = markets.filter((m) => marketClass(m, excludedAddresses) !== 'ignored')
    stderr(
      `count-fans: ${markets.length} GameMarket accounts on ${rpcShown}; reading the ` +
        `transactions of ${read.length} counted or excluded markets\n`,
    )
    const swaps = await fetchSwaps(rpc, read, (done, total) => {
      if (done % 100 === 0 || done === total) stderr(`count-fans: transactions ${done}/${total}\n`)
    })
    const report = countFans({ markets, swaps, wallets })
    const meta = { rpc: rpcShown, elapsedMs: now() - started }
    stdout(
      options.json
        ? `${JSON.stringify({ ...report, ...meta }, null, 2)}\n`
        : `${formatReport(report, meta)}\n`,
    )
    stderr(`count-fans: RPC requests sent: ${rpc.calls}\n`)
    return 0
  } catch (error) {
    return fail(3, [describeError(error), 'stopped: no number was printed'])
  }
}

// Runs main only when this file is the program, as in `node scripts/count-fans.mjs`. Importing the
// module, as the tests do, runs nothing.
function isProgram() {
  if (process.argv[1] === undefined) return false
  let invoked
  try {
    invoked = realpathSync(process.argv[1])
  } catch {
    return false
  }
  const self = fileURLToPath(import.meta.url)
  return process.platform === 'win32'
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self
}

if (isProgram()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
