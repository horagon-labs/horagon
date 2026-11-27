// The buzzer (culture A2, R8): when trading stopped and how the face says so. Pure: the static
// buzzer index's price, when a Buzzer stop plays (never on load), and its words, strings 14 and
// 15 of the culture plan. The keeper halts a market on the first Final read, or on the horn
// held 10 s (period 4 or later, clock 0, not tied); the web reads either as the close at the
// buzzer.
import type { Game, GameHistory, Position } from '@horagon/sdk'
import { parseAmount } from '@horagon/sdk/amount'
import { percent } from '../format'
import type { DialState } from './state'

/** The faces after trading stopped: the buzzer index shows on each. */
export const STOPPED_FACES: readonly DialState[] = ['closed', 'proposed', 'challenged', 'resolved']
export const isStoppedFace = (state: DialState): boolean => STOPPED_FACES.includes(state)

/** The whole Buzzer stop, about 1.6 s, the same for every result. */
export const STOP_MS = 1_600
/** The ink ring at r96: 150 ms in, 600 ms out. */
export const STOP_RING_IN_MS = 150
export const STOP_RING_OUT_MS = 600
/** The index drops at +200 ms; the needle turns ink-muted at +400 ms. */
export const STOP_INDEX_AT_MS = 200
export const STOP_NEEDLE_AT_MS = 400
/** A holder's phone: short, pause, short (Android only, through `buzz`). */
export const STOP_BUZZ: readonly number[] = [30, 80, 30]
/** What a screen reader hears when it plays. */
export const STOP_SPOKEN = 'Stopped at the buzzer'

type HornFields = Pick<Game, 'status' | 'period' | 'clockSecs' | 'homeScore' | 'awayScore'>

/** The horn frame: live, period 4 or later, clock 0, and not tied (a tie goes to overtime). */
export const isHornFrame = (g: HornFields): boolean =>
  g.status === 'live' && g.period >= 4 && g.clockSecs === 0 && g.homeScore !== g.awayScore

/**
 * Trading stopped at the buzzer: the Final, or the horn frame, halted or not yet (the keeper
 * holds it 10 s before its halt lands; the dial reads it closed already, as for the Final).
 */
export const atBuzzer = (g: HornFields): boolean => g.status === 'final' || isHornFrame(g)

/**
 * The buzzer index's price (home side): the last history price at or before trading stopped,
 * `stopTs` (end_ts at the latest: no trade lands after the halt), else the current price.
 */
export function stopPrice(
  history: GameHistory | undefined,
  market: string,
  stopTs: number,
  fallback: number | null,
): number | null {
  let best: { ts: number; price: number } | undefined
  for (const p of history?.prices ?? []) {
    if (p.market !== market || p.ts > stopTs) continue
    if (!best || p.ts >= best.ts) best = p
  }
  return best?.price ?? fallback
}

/** What a page remembers between renders: did it see the market open, and did the stop play. */
export interface StopMemory {
  sawOpen: boolean
  played: boolean
}

export const NEW_STOP_MEMORY: StopMemory = { sawOpen: false, played: false }

/**
 * One render's step. A Buzzer stop plays once, only on a page that saw the market trade in this
 * session and then sees the buzzer. A page opened after the buzzer never plays it.
 */
export function stopStep(
  m: StopMemory,
  now: { trading: boolean; buzzer: boolean },
): { memory: StopMemory; play: boolean } {
  if (now.trading) return { memory: { sawOpen: true, played: m.played }, play: false }
  const play = m.sawOpen && !m.played && now.buzzer
  return { memory: { sawOpen: m.sawOpen, played: m.played || play }, play }
}

/** String 14: "Stopped at the buzzer · CHI 107–105 CHA" (away first, as the scorebug). */
export const stopLine = (g: Pick<Game, 'home' | 'away' | 'homeScore' | 'awayScore'>): string =>
  `Stopped at the buzzer · ${g.away} ${g.awayScore}–${g.homeScore} ${g.home}`

/** The holder's largest winner position in this game, if any. */
function held(positions: readonly Position[] | undefined, gameId: string): Position | undefined {
  let best: Position | undefined
  for (const p of positions ?? []) {
    if (p.gameId !== gameId || p.kind !== 'winner' || parseAmount(p.shares) <= 0n) continue
    if (!best || parseAmount(p.shares) > parseAmount(best.shares)) best = p
  }
  return best
}

/** The average entry on the holder's side (cost / shares), 0..1; null without shares. */
export function averageEntry(p: Pick<Position, 'shares' | 'costUsdc'>): number | null {
  const shares = Number(p.shares)
  if (!(shares > 0)) return null
  return Math.min(1, Math.max(0, Number(p.costUsdc) / shares))
}

/**
 * The dial-face ◆ (h): the holder's average entry as a home-side price, so it sits on the same
 * scale as the needle (1 − it for an away position). Null without a position.
 */
export function entryMark(
  positions: readonly Position[] | undefined,
  gameId: string,
): number | null {
  const p = held(positions, gameId)
  const entry = p ? averageEntry(p) : null
  if (!p || entry === null) return null
  return p.side === 'home' ? entry : 1 - entry
}

/**
 * String 15, for a holder: "You backed CLE at 38%. At the horn the price had CLE at 71%." Both
 * numbers are the held side's. Null without a position or a stop price.
 */
export function holderLine(
  g: Pick<Game, 'id' | 'home' | 'away'>,
  positions: readonly Position[] | undefined,
  homeStopPrice: number | null,
): string | null {
  const p = held(positions, g.id)
  const entry = p ? averageEntry(p) : null
  if (!p || entry === null || homeStopPrice === null) return null
  const team = p.side === 'home' ? g.home : g.away
  const atHorn = p.side === 'home' ? homeStopPrice : 1 - homeStopPrice
  return `You backed ${team} at ${percent(entry)}. At the horn the price had ${team} at ${percent(atHorn)}.`
}
