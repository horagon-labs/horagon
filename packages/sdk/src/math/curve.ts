import { cdf, cdfInv, pdf } from './normal'

/** pm-AMM clamps prices to this range before inverting them (pm_math.rs). */
export const PRICE_MIN = 0.0001
export const PRICE_MAX = 0.9999
/** Bisection bounds for u = Phi^-1(P) (pm_math.rs Z_SEARCH_MIN/MAX). */
export const Z_SEARCH = 6
/** Clamp for the sell paths (pm_math.rs Z_CLAMP_LO/HI). */
export const Z_CLAMP = 5.9
const BISECT_ITERATIONS = 100

export type SwapDirection =
  | 'usdcToYes'
  | 'usdcToNo'
  | 'yesToUsdc'
  | 'noToUsdc'
  | 'yesToNo'
  | 'noToYes'

export const SWAP_DIRECTIONS: readonly SwapDirection[] = [
  'usdcToYes',
  'usdcToNo',
  'yesToUsdc',
  'noToUsdc',
  'yesToNo',
  'noToYes',
]

/** Pool reserves: x is the YES reserve, y is the NO reserve. */
export interface Reserves {
  x: number
  y: number
}

export interface SwapResult {
  /** Gross output of the curve, before any fee. */
  output: number
  xNew: number
  yNew: number
  /** YES price after the swap. */
  priceNew: number
}

/** L_eff = L_0 * sqrt(T - t). */
export function lEffective(lZero: number, timeRemainingSecs: number): number {
  if (!(timeRemainingSecs > 0)) {
    throw new RangeError(`lEffective: time remaining must be > 0, got ${timeRemainingSecs}`)
  }
  return lZero * Math.sqrt(timeRemainingSecs)
}

/** Reserves at u = Phi^-1(P): x = L(u*Phi(u) + phi(u) - u), y = L(u*Phi(u) + phi(u)). */
export function xyFromU(u: number, lEff: number): Reserves {
  const base = u * cdf(u) + pdf(u)
  return { x: lEff * (base - u), y: lEff * base }
}

export function reservesFromPrice(price: number, lEff: number): Reserves {
  if (!(price >= PRICE_MIN && price <= PRICE_MAX)) {
    throw new RangeError(
      `reservesFromPrice: price must be in [${PRICE_MIN}, ${PRICE_MAX}], got ${price}`,
    )
  }
  return xyFromU(cdfInv(price), lEff)
}

/** P = Phi((y - x) / L_eff). */
export function priceFromReserves(x: number, y: number, lEff: number): number {
  return cdf((y - x) / lEff)
}

/** y(u) increases with u and x(u) decreases with u, so bisection finds u for a target reserve. */
function solveU(target: number, lEff: number, reserve: 'x' | 'y'): number {
  let lo = -Z_SEARCH
  let hi = Z_SEARCH
  for (let i = 0; i < BISECT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    const r = xyFromU(mid, lEff)
    const belowTarget = reserve === 'y' ? r.y < target : r.x > target
    if (belowTarget) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export function findXFromY(yTarget: number, lEff: number): number {
  return xyFromU(solveU(yTarget, lEff, 'y'), lEff).x
}

export function findYFromX(xTarget: number, lEff: number): number {
  return xyFromU(solveU(xTarget, lEff, 'x'), lEff).y
}

function clampZ(z: number): number {
  return Math.min(Z_CLAMP, Math.max(-Z_CLAMP, z))
}

/** Port of pm_math.rs `compute_swap_output`: the same six mechanisms, no fee. */
export function computeSwapOutput(
  reserves: Reserves,
  lEff: number,
  deltaIn: number,
  direction: SwapDirection,
): SwapResult {
  const { x, y } = reserves
  let output: number
  let xNew: number
  let yNew: number
  switch (direction) {
    case 'usdcToYes':
      yNew = y + deltaIn
      xNew = findXFromY(yNew, lEff)
      output = deltaIn + (x - xNew)
      break
    case 'usdcToNo':
      xNew = x + deltaIn
      yNew = findYFromX(xNew, lEff)
      output = deltaIn + (y - yNew)
      break
    case 'yesToUsdc': {
      const r = xyFromU(clampZ((y - x - deltaIn) / lEff), lEff)
      xNew = r.x
      yNew = r.y
      output = y - yNew
      break
    }
    case 'noToUsdc': {
      const r = xyFromU(clampZ((y - x + deltaIn) / lEff), lEff)
      xNew = r.x
      yNew = r.y
      output = x - xNew
      break
    }
    case 'yesToNo':
      xNew = x + deltaIn
      yNew = findYFromX(xNew, lEff)
      output = y - yNew
      break
    case 'noToYes':
      yNew = y + deltaIn
      xNew = findXFromY(yNew, lEff)
      output = x - xNew
      break
  }
  return { output, xNew, yNew, priceNew: priceFromReserves(xNew, yNew, lEff) }
}
