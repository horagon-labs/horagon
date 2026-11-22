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
// RPC and CLI: Task A2 adds createRpc, fetchGameMarkets, fetchSignatures, fetchSwaps, main and
// the main guard below this line.
