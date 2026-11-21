// Display helpers. Prices are the home team's win probability (YES); AWAY shows 1 - price.
import type { Game, GameHistory } from '@horagon/sdk'

export const CLUSTER = 'devnet'

// Edges stay honest while a market trades: under 1 shows "<1", over 99 shows ">99".
function whole(p: number | null | undefined, unit: string): string {
  if (p === null || p === undefined) return '–'
  const r = Math.round(p * 100)
  if (p > 0 && r < 1) return `<1${unit}`
  if (p < 1 && r > 99) return `>99${unit}`
  return `${r}${unit}`
}

export const cents = (p: number | null | undefined): string => whole(p, '¢')

export const percent = (p: number | null | undefined): string => whole(p, '%')

/** "1234.5" -> "1,234.50". Rounds down, so a balance never shows more than the wallet holds. */
export function usdc(amount: string | number): string {
  const text = typeof amount === 'number' ? String(amount) : amount.trim()
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text)
  if (m) {
    const int = BigInt(m[1] ?? '0').toLocaleString('en-US')
    return `${int}.${(m[2] ?? '').padEnd(2, '0').slice(0, 2)}`
  }
  const n = Math.floor(Number(text) * 100) / 100
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const mmss = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
const periodName = (p: number) => (p <= 4 ? `Q${p}` : p === 5 ? 'OT' : `${p - 4}OT`)

type ClockFields = Pick<Game, 'status' | 'period' | 'clockSecs' | 'scheduledTipoff'>

/** "Q3 5:12", "Half", "Final/OT", or the local tip-off time before the game. */
export function gameClock(g: ClockFields, timeZone?: string): string {
  switch (g.status) {
    case 'scheduled':
      return new Date(g.scheduledTipoff).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        ...(timeZone ? { timeZone } : {}),
      })
    case 'live':
      if (g.clockSecs === 0 && g.period === 2) return 'Half'
      if (g.clockSecs === 0) return `End ${periodName(g.period)}`
      return g.clockSecs === null
        ? periodName(g.period)
        : `${periodName(g.period)} ${mmss(g.clockSecs)}`
    case 'final':
      return g.period > 4 ? `Final/${periodName(g.period)}` : 'Final'
    case 'postponed':
      return 'Postponed'
    case 'canceled':
      return 'Canceled'
  }
}

/** "1:02:03" until `endTs`, "4:05" under an hour, "Closed" after. */
export function countdown(endTs: number, nowSecs: number): string {
  const left = Math.max(0, Math.floor(endTs - nowSecs))
  if (left === 0) return 'Closed'
  const h = Math.floor(left / 3600)
  const rest = mmss(left % 3600)
  return h > 0 ? `${h}:${rest.padStart(5, '0')}` : rest
}

const HOUR_MS = 3_600_000

/** Tonight: live games, plus games tipping off from 4 h ago to 24 h ahead of the viewer. */
export function isTonight(g: Pick<Game, 'status' | 'scheduledTipoff'>, nowMs: number): boolean {
  if (g.status === 'live') return true
  const t = Date.parse(g.scheduledTipoff)
  return t >= nowMs - 4 * HOUR_MS && t <= nowMs + 24 * HOUR_MS
}

/** Featured first, then live, then by tip-off. */
export function tonightOrder(a: Game, b: Game): number {
  if (a.featured !== b.featured) return a.featured ? -1 : 1
  if ((a.status === 'live') !== (b.status === 'live')) return a.status === 'live' ? -1 : 1
  return Date.parse(a.scheduledTipoff) - Date.parse(b.scheduledTipoff)
}

export interface RunMarker {
  ts: number
  team: 'home' | 'away'
  points: number
}

/**
 * One marker per scoring run of `min`+ unanswered points (spec 10: "a team scores >= 8 in a
 * row"), placed at the snapshot where the run reaches `min`. A snapshot where both teams
 * scored ends any run.
 */
export function scoringRuns(snapshots: GameHistory['snapshots'], min = 8): RunMarker[] {
  const out: RunMarker[] = []
  let team: 'home' | 'away' | null = null
  let points = 0
  let marked = false
  let prev: { home: number; away: number } | null = null
  for (const s of [...snapshots].sort((a, b) => a.ts - b.ts)) {
    if (prev !== null) {
      const dh = s.homeScore - prev.home
      const da = s.awayScore - prev.away
      if (dh > 0 && da > 0) team = null
      else if (dh > 0 || da > 0) {
        const scorer = dh > 0 ? 'home' : 'away'
        if (scorer !== team) {
          team = scorer
          points = 0
          marked = false
        }
        points += Math.max(dh, da)
        if (!marked && points >= min) {
          out.push({ ts: s.ts, team: scorer, points })
          marked = true
        }
      }
    }
    prev = { home: s.homeScore, away: s.awayScore }
  }
  return out
}

export const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`
export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`
export const explorerAddress = (addr: string) =>
  `https://explorer.solana.com/address/${addr}?cluster=${CLUSTER}`
