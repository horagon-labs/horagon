/** sqrt(2 * pi). */
export const SQRT_2PI = 2.5066282746310002

/** phi(z): the standard normal density. */
export function pdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI
}

/**
 * Phi(z): the standard normal CDF, with relative error below 1e-13 in both tails.
 * |z| < 3: Hart (1968) rational approximation, as given by West (2005), "Better
 * approximations to cumulative normal functions". |z| >= 3: 60-term continued fraction
 * for the Mills ratio, Q(a) = phi(a) / (a + 1/(a + 2/(a + 3/(a + ...)))).
 */
export function cdf(z: number): number {
  const a = Math.abs(z)
  let tail: number
  if (a > 40) {
    tail = 0
  } else if (a < 3) {
    let n = 3.52624965998911e-2 * a + 0.700383064443688
    n = n * a + 6.37396220353165
    n = n * a + 33.912866078383
    n = n * a + 112.079291497871
    n = n * a + 221.213596169931
    n = n * a + 220.206867912376
    let d = 8.83883476483184e-2 * a + 1.75566716318264
    d = d * a + 16.064177579207
    d = d * a + 86.7807322029461
    d = d * a + 296.564248779674
    d = d * a + 637.333633378831
    d = d * a + 793.826512519948
    d = d * a + 440.413735824752
    tail = (Math.exp(-0.5 * a * a) * n) / d
  } else {
    let b = a
    for (let k = 60; k >= 1; k--) b = a + k / b
    tail = Math.exp(-0.5 * a * a) / b / SQRT_2PI
  }
  return z > 0 ? 1 - tail : tail
}

// Acklam's rational approximation coefficients (same values as pm-AMM's pm_math.rs).
const A = [
  -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
  2.506628277459239,
] as const
const B = [
  -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572,
] as const
const C = [
  -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
] as const
const D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416] as const
const P_LOW = 0.02425

function acklamTail(q: number): number {
  return (
    (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
    ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
  )
}

/**
 * Phi^-1(p): the standard normal quantile for p in (0, 1), relative error below 1e-12.
 * Acklam's approximation over the full range (central region and both tails),
 * refined with one Halley step against `cdf`.
 */
export function cdfInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`cdfInv: p must be in (0, 1), got ${p}`)
  let x: number
  if (p < P_LOW) {
    x = acklamTail(Math.sqrt(-2 * Math.log(p)))
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5
    const r = q * q
    x =
      ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
      (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
  } else {
    x = -acklamTail(Math.sqrt(-2 * Math.log(1 - p)))
  }
  const e = cdf(x) - p
  const u = e * SQRT_2PI * Math.exp(0.5 * x * x)
  return x - u / (1 + 0.5 * x * u)
}
