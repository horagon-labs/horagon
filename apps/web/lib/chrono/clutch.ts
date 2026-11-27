// Clutch time and the needle's moves (culture A2, R8). Pure. Clutch dims the face's ticks and
// rules while the game is close at the end and the price is still in doubt (string 12); the
// spring bounces with the size of the move, a chip prints a move of 3 points or more, and a run
// flashes the ring only when it moved the price by 2 points or more.
import type { Game } from '@horagon/sdk'
import { gameClock } from '../format'
import type { DialState } from './state'

/** The doubt gate: the price, either side, between 10% and 90%. */
export const CLUTCH_LOW = 0.1
export const CLUTCH_HIGH = 0.9
/** Q4 with two minutes or less on the clock, or any overtime. */
export const CLUTCH_SECS = 120
/** The dim's timing: 1.2 s in, 0.6 s out (instant with reduced motion). */
export const CLUTCH_IN_MS = 1_200
export const CLUTCH_OUT_MS = 600
/** The Feel switch's label (default on). */
export const CLUTCH_SWITCH = 'Dim the screen in clutch time'

export interface ClutchInput {
  state: DialState
  /** The home side's price; null for no price. */
  price: number | null
  game: Pick<Game, 'status' | 'period' | 'clockSecs'>
  /** The Feel switch. */
  enabled: boolean
}

/**
 * Clutch time: live and trading, the price in doubt, the end of Q4 or overtime, switch on. Never
 * at 0:00 of Q4 or an overtime: the clock has stopped, at the horn or before an overtime.
 */
export function isClutch(i: ClutchInput): boolean {
  if (!i.enabled || i.game.status !== 'live') return false
  if (i.state !== 'live' && i.state !== 'closing') return false
  if (i.price === null || i.price < CLUTCH_LOW || i.price > CLUTCH_HIGH) return false
  const g = i.game
  if (g.period >= 4 && g.clockSecs === 0) return false
  return g.period >= 5 || (g.period === 4 && g.clockSecs !== null && g.clockSecs <= CLUTCH_SECS)
}

/** String 12: "Clutch · Q4 1:48 · open until the final buzzer". */
export const clutchLine = (g: Parameters<typeof gameClock>[0]): string =>
  `Clutch · ${gameClock(g)} · open until the final buzzer`

/** The needle spring's bounce for a move of `dp` (0..1): bigger moves swing further. */
export const springBounce = (dp: number): number =>
  Math.min(0.3, 0.15 + 1.5 * Math.abs(Number.isFinite(dp) ? dp : 0))

/** How long the move chip stays. */
export const CHIP_MS = 3_000
/** A move of this many points or more prints a chip. */
export const CHIP_POINTS = 3

/** Whole points between two home-side prices. */
export const pointsMoved = (from: number, to: number): number =>
  Math.round(to * 100) - Math.round(from * 100)

/** "+5" or "−5" (U+2212, never ▲) for a move of 3 points or more; null for less. */
export function moveChip(from: number | null, to: number | null): string | null {
  if (from === null || to === null) return null
  const pts = pointsMoved(from, to)
  if (Math.abs(pts) < CHIP_POINTS) return null
  return `${pts > 0 ? '+' : '−'}${Math.abs(pts)}`
}

/** A run flashes the ring only when it moved the price by 2 points or more. */
export const RUN_FLASH_POINTS = 2
export const runFlashes = (priceFrom: number | null, priceTo: number | null): boolean =>
  priceFrom !== null &&
  priceTo !== null &&
  Math.abs(pointsMoved(priceFrom, priceTo)) >= RUN_FLASH_POINTS
