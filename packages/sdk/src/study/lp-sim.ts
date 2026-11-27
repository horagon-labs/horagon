// A simulation, not chain data: the pm-AMM paper's Gaussian-score dynamics with an arbitrageur,
// to show where a dynamic pm-AMM pool (L_eff = L0 * sqrt(T - t)) loses value over a market's
// life. The score Z is a Brownian motion from 0 to T = 1; YES wins when Z_T > 0, so the fair
// price is Phi(Z_t / sqrt(T - t)). Each step the pool's liquidity decays at a constant price, as
// the program accrues before a swap, and an arbitrageur then trades the pool to the fair price.
// The pool's loss is that trade's value to the arbitrageur at the fair price. The paper predicts
// a uniform expected loss rate, half the starting value by T. Seeded, so deterministic.
import { lEffective, PRICE_MAX, PRICE_MIN, reservesFromPrice } from '../math/curve'
import { cdf, cdfInv, pdf } from '../math/normal'

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export interface LpSimBucket {
  /** Share of the market's life, [from, to). */
  from: number
  to: number
  /** Mean loss over the paths, as a share of the pool's starting value. */
  loss: number
  /** The uniform-loss-rate prediction for the bucket: (to - from) / 2. */
  predicted: number
}

export interface LpSim {
  seed: number
  paths: number
  steps: number
  startPrice: number
  buckets: LpSimBucket[]
  totalLoss: number
  predictedTotal: number
}

export interface LpSimOptions {
  steps?: number
  buckets?: number
  startPrice?: number
}

const clamp = (p: number) => Math.min(PRICE_MAX, Math.max(PRICE_MIN, p))

function value(x: number, y: number, p: number): number {
  return p * x + (1 - p) * y
}

export function lpLossSim(seed: number, paths: number, opts: LpSimOptions = {}): LpSim {
  const steps = opts.steps ?? 240
  const nBuckets = opts.buckets ?? 6
  const startPrice = opts.startPrice ?? 0.5
  const rand = mulberry32(seed)
  const normal = () => {
    // Box-Muller; 1 - u keeps the log away from 0.
    const u = 1 - rand()
    const v = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const dt = 1 / steps
  const u0 = cdfInv(startPrice)
  // V0 = L0 * sqrt(T) * phi(u0) = 1, so every loss reads as a share of the starting value.
  const lZero = 1 / pdf(u0)
  const sums = new Array<number>(nBuckets).fill(0)
  for (let path = 0; path < paths; path++) {
    let z = u0
    let price = startPrice
    for (let k = 0; k < steps; k++) {
      z += Math.sqrt(dt) * normal()
      const remaining = 1 - (k + 1) * dt
      // At T the pool holds nothing: no trade, no loss.
      if (remaining <= 1e-12) continue
      const lEff = lEffective(lZero, remaining)
      const fair = clamp(cdf(z / Math.sqrt(remaining)))
      const pre = reservesFromPrice(clamp(price), lEff)
      const post = reservesFromPrice(fair, lEff)
      const loss = value(pre.x, pre.y, fair) - value(post.x, post.y, fair)
      const bucket = Math.min(nBuckets - 1, Math.floor((k * nBuckets) / steps))
      sums[bucket] = (sums[bucket] ?? 0) + loss
      price = fair
    }
  }
  const buckets = sums.map((sum, i) => ({
    from: i / nBuckets,
    to: (i + 1) / nBuckets,
    loss: paths === 0 ? 0 : sum / paths,
    predicted: 1 / nBuckets / 2,
  }))
  return {
    seed,
    paths,
    steps,
    startPrice,
    buckets,
    totalLoss: buckets.reduce((a, b) => a + b.loss, 0),
    predictedTotal: 0.5,
  }
}
