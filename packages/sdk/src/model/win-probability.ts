import { HoragonError } from '../errors'
import { cdf, cdfInv } from '../math/normal'

export interface WinProbabilityInput {
  /** Home points minus away points. */
  margin: number
  /** Minutes left in regulation, or in the current overtime period. */
  minutesRemaining: number
  /** Pre-game home win probability, in (0, 1). */
  p0: number
  /** Standard deviation of the final margin over a full game, in points. */
  sigma: number
}

/**
 * In-game home win probability, Brownian model (Stern 1994):
 * P = Phi((d + mu*tau) / (sigma*sqrt(tau))), tau = minutes left / 48, mu = sigma*Phi^-1(p0),
 * so P = p0 at tip-off with a tied score. Display only: Horagon never trades on it.
 */
export function winProbability(input: WinProbabilityInput): number {
  const { margin, minutesRemaining, p0, sigma } = input
  if (!Number.isFinite(margin))
    throw new HoragonError('INVALID_INPUT', `margin must be finite, got ${margin}`)
  if (!(minutesRemaining >= 0)) {
    throw new HoragonError(
      'INVALID_INPUT',
      `minutesRemaining must be >= 0, got ${minutesRemaining}`,
    )
  }
  if (!(p0 > 0 && p0 < 1))
    throw new HoragonError('INVALID_INPUT', `p0 must be in (0, 1), got ${p0}`)
  if (!(sigma > 0)) throw new HoragonError('INVALID_INPUT', `sigma must be > 0, got ${sigma}`)
  const tau = minutesRemaining / 48
  if (tau === 0) return margin > 0 ? 1 : margin < 0 ? 0 : 0.5
  const mu = sigma * cdfInv(p0)
  return cdf((margin + mu * tau) / (sigma * Math.sqrt(tau)))
}
