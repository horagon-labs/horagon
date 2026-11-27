// How good the pre-game model's opening price was, from outcomes alone: the Brier score, the log
// loss, the base-rate baselines and the reliability bins folded to the favourite. Pure; every
// number is meant to ship with its sample size.
import { isUpset } from './upset'

/** One market: the model's home win chance at the open (0..1) and whether the home team won. */
export interface CalibrationSample {
  p: number
  homeWon: boolean
}

/** The Brier score of a constant 50% forecast. */
export const BASELINE_BRIER = 0.25
/** The log loss of a constant 50% forecast: ln 2. */
export const BASELINE_LOG_LOSS = Math.LN2

/** log loss clamps forecasts here, so a 0% or 100% forecast stays finite. */
const P_EDGE = 1e-4

/** Mean of (p - outcome)^2; null on an empty sample. */
export function brier(samples: readonly CalibrationSample[]): number | null {
  if (samples.length === 0) return null
  let sum = 0
  for (const { p, homeWon } of samples) sum += (p - (homeWon ? 1 : 0)) ** 2
  return sum / samples.length
}

/** Mean of -ln(chance given to what happened); null on an empty sample. */
export function logLoss(samples: readonly CalibrationSample[]): number | null {
  if (samples.length === 0) return null
  let sum = 0
  for (const { p, homeWon } of samples) {
    const q = Math.min(1 - P_EDGE, Math.max(P_EDGE, p))
    sum -= Math.log(homeWon ? q : 1 - q)
  }
  return sum / samples.length
}

export interface ReliabilityBin {
  /** Favourite's forecast range in percent, [from, to); the last bin includes 100. */
  from: number
  to: number
  count: number
  /** Mean favourite forecast (0..1) in the bin; null when empty. */
  meanForecast: number | null
  /** How many favourites in the bin won. */
  favouriteWon: number
}

const BIN_EDGES = [50, 60, 70, 80, 90, 100] as const

/**
 * Five bins of the favourite's forecast (50-60 … 90-100), each with its count. A forecast is
 * folded to the favourite (max(p, 1 - p)); at exactly 50% the home team is the favourite.
 */
export function reliabilityBins(samples: readonly CalibrationSample[]): ReliabilityBin[] {
  const bins = BIN_EDGES.slice(0, -1).map((from, i) => ({
    from,
    to: BIN_EDGES[i + 1] as number,
    count: 0,
    sum: 0,
    favouriteWon: 0,
  }))
  for (const { p, homeWon } of samples) {
    const homeFavourite = p >= 0.5
    const f = homeFavourite ? p : 1 - p
    // Whole basis points first, so 0.6 lands in 60-70 and not in 50-60 by a rounding error.
    const pct = Math.round(f * 10_000) / 100
    const bin = bins[Math.min(bins.length - 1, Math.floor((pct - 50) / 10))]
    if (!bin) continue
    bin.count++
    bin.sum += f
    if (homeWon === homeFavourite) bin.favouriteWon++
  }
  return bins.map(({ from, to, count, sum, favouriteWon }) => ({
    from,
    to,
    count,
    meanForecast: count === 0 ? null : sum / count,
    favouriteWon,
  }))
}

export interface Calibration {
  n: number
  brier: number | null
  logLoss: number | null
  baselineBrier: number
  baselineLogLoss: number
  bins: ReliabilityBin[]
  /** Markets whose winner opened at 33% or less. */
  upsets: number
}

export function calibration(samples: readonly CalibrationSample[]): Calibration {
  return {
    n: samples.length,
    brier: brier(samples),
    logLoss: logLoss(samples),
    baselineBrier: BASELINE_BRIER,
    baselineLogLoss: BASELINE_LOG_LOSS,
    bins: reliabilityBins(samples),
    upsets: samples.filter((x) => isUpset(Math.round(x.p * 10_000), x.homeWon)).length,
  }
}
