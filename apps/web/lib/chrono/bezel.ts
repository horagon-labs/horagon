// The bezel's steps (spec 3.1): a non-linear buy ladder cut at the balance, whose last step is
// the balance itself, and a sell ladder of percentages of the shares held. Steps sit evenly on
// the same 270° arc as the price scale; a drag clamps at both ends and never wraps around.
import { formatAmount, parseAmount } from '@horagon/sdk'
import { MIN_ANGLE, SWEEP } from './geometry'

export const BUY_LADDER = ['1', '2', '5', '10', '25', '50', '100', '250'] as const
export const SELL_PERCENTS = [10, 25, 50, 75, 100] as const

export interface Step {
  /** The amount useTrade sends: mUSDC to spend, or shares to sell. */
  amount: string
  /** For aria-valuetext and the readout: "25 mUSDC", "50% · 7.05 shares". */
  text: string
}

/** Parses an amount, or null when it is not one (an empty or garbled balance). */
function units(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null
  try {
    return parseAmount(value)
  } catch {
    return null
  }
}

/**
 * Buy steps under `balance` plus the balance as the last step (Review Focus 2): 0.5 gives one
 * step of 0.5, exactly 25 gives ..., 10, 25 once. An unknown balance gives the whole ladder.
 */
export function buySteps(balance: string | null | undefined): Step[] {
  const cap = units(balance)
  const ladder = BUY_LADDER.map((a) => parseAmount(a))
  const amounts =
    cap === null ? ladder : [...ladder.filter((a) => a < cap), ...(cap > 0n ? [cap] : [])]
  return amounts.map((a) => ({ amount: formatAmount(a), text: `${formatAmount(a)} mUSDC` }))
}

/**
 * Sell steps as shares of `shares`, rounded down to the 6th decimal so a step never asks for
 * more than is held (Review Focus 5); 100% is exactly the shares held. Steps that round to the
 * same amount, or to nothing, appear once or not at all.
 */
export function sellSteps(shares: string | undefined): Step[] {
  const out: Step[] = []
  for (const pct of SELL_PERCENTS) {
    const a = percentOf(shares, pct)
    if (a === null || out.some((s) => s.amount === a)) continue
    out.push({ amount: a, text: `${pct}% · ${a} shares` })
  }
  return out
}

/** `pct`% of the shares held, rounded down to the 6th decimal; null when that is nothing. */
export function percentOf(shares: string | undefined, pct: number): string | null {
  const held = units(shares)
  if (held === null || held <= 0n) return null
  const a = (held * BigInt(pct)) / 100n
  return a === 0n ? null : formatAmount(a)
}

/** The step showing for `amount`: the largest step not above it, else the first. */
export function stepIndex(steps: readonly Step[], amount: string): number {
  const want = units(amount.trim())
  if (want === null) return 0
  let best = 0
  steps.forEach((s, i) => {
    if (parseAmount(s.amount) <= want) best = i
  })
  return best
}

export const stepAngle = (index: number, count: number): number =>
  count <= 1 ? MIN_ANGLE : MIN_ANGLE + (index * SWEEP) / (count - 1)

export function angleToStep(angle: number, count: number): number {
  if (count <= 1) return 0
  const i = Math.round(((angle - MIN_ANGLE) * (count - 1)) / SWEEP)
  return Math.min(count - 1, Math.max(0, i))
}

/** The pointer's angle about the center, clockwise from 12 o'clock, in (-180, 180]. */
export function pointerAngle(x: number, y: number, cx: number, cy: number): number {
  return (Math.atan2(x - cx, cy - y) * 180) / Math.PI
}

/**
 * The next drag angle (Review Focus 3): the raw pointer angle moved to the turn nearest the
 * previous angle. It is never clamped here, so a drag that runs past either end, through the gap
 * at the bottom and on round the dial, stays past that end until it comes back the same way;
 * `angleToStep` clamps it to the first or last step.
 */
export function dragAngle(prev: number, raw: number): number {
  return raw + Math.round((prev - raw) / 360) * 360
}

/** A step changed: the moment to buzz and tick (spec 2.5). */
export const stepCrossed = (prev: number, next: number): boolean => prev !== next

/** One wheel notch is one step: up (away from you) is more. */
export const wheelStep = (deltaY: number): number => (deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0)
