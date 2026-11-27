// The study's published snapshot (apps/web/content/study.json): one row per resolved kind-0 NBA
// market of a game that was played, read from chain by apps/keeper/scripts/study.ts, plus the
// scores, a per-night breakdown, the depth curves and the LP simulation. Pure: the script does
// the chain part and checks the evidence.
import { z } from 'zod'
import { FIRST_COUNTED_NIGHT } from '../nights'
import { calibration } from './calibration'
import {
  CREATE_LEAD_SECS,
  depthCurve,
  END_OFFSET_BEFORE_R1_SECS,
  END_OFFSET_SECS,
  MEDIAN_FINAL_MINUTES,
  REGULAR_SEED_USDC,
} from './depth'
import { lpLossSim } from './lp-sim'

export const STUDY_SCHEMA_VERSION = 1

const Date10 = z.iso.date()
const Count = z.number().int().nonnegative()
const Score = z.number().nonnegative().nullable()

export const StudyRowSchema = z.strictObject({
  /** The pm-AMM Market account. */
  market: z.string(),
  /** The horagon GameMarket account that points at it. */
  gameMarket: z.string(),
  home: z.string(),
  away: z.string(),
  tipoff: z.iso.datetime(),
  /** The model's home win chance at the open, as written on chain. */
  initialPriceBps: z.number().int().min(0).max(10_000),
  outcome: z.enum(['home', 'away']),
  /** The ET night (YYYY-MM-DD). */
  night: Date10,
})

const StudyGameSchema = StudyRowSchema.omit({ initialPriceBps: true, outcome: true })

/**
 * A resolved market left out because it cannot be read: its pm-AMM account is gone ('account'),
 * or its evidence could not be fetched, does not hash to the hash on chain, or names another game
 * or outcome ('evidence'). Listed, never guessed.
 */
export const StudyMissingSchema = StudyGameSchema.extend({
  reason: z.enum(['account', 'evidence']),
})

/**
 * A resolved market whose checked evidence says the game was not played within 7 days: it resolved
 * NO by rule, which is not an away win, so it is listed and never scored.
 */
export const StudyNotPlayedSchema = StudyGameSchema

const BinSchema = z.strictObject({
  from: z.number(),
  to: z.number(),
  count: Count,
  meanForecast: z.number().nullable(),
  favouriteWon: Count,
})

export const StudyCalibrationSchema = z.strictObject({
  n: Count,
  brier: Score,
  logLoss: Score,
  baselineBrier: z.number(),
  baselineLogLoss: z.number(),
  bins: z.array(BinSchema),
  upsets: Count,
})

const NightSchema = z.strictObject({
  night: Date10,
  n: Count,
  brier: Score,
  logLoss: Score,
  upsets: Count,
  /** On or after FIRST_COUNTED_NIGHT. */
  counted: z.boolean(),
})

const DepthPointSchema = z.strictObject({
  minute: z.number(),
  depthShare: z.number(),
  move10: z.number().nullable(),
  move100: z.number().nullable(),
})

const DepthSchema = z.strictObject({
  seedUsdc: z.number(),
  createLeadSecs: z.number(),
  medianFinalMinutes: z.number(),
  curves: z.array(
    z.strictObject({ endOffsetSecs: z.number().int(), points: z.array(DepthPointSchema) }),
  ),
})

const LpSimSchema = z.strictObject({
  seed: z.number().int(),
  paths: Count,
  steps: Count,
  startPrice: z.number(),
  buckets: z.array(
    z.strictObject({ from: z.number(), to: z.number(), loss: z.number(), predicted: z.number() }),
  ),
  totalLoss: z.number(),
  predictedTotal: z.number(),
})

export const StudySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(STUDY_SCHEMA_VERSION),
  /** UTC; null in the empty snapshot, before the script's first run. */
  generatedAt: z.iso.datetime().nullable(),
  slot: Count.nullable(),
  programIds: z.strictObject({ horagon: z.string(), pmAmm: z.string() }),
  firstCountedNight: Date10,
  rows: z.array(StudyRowSchema),
  missing: z.array(StudyMissingSchema),
  notPlayed: z.array(StudyNotPlayedSchema),
  calibration: StudyCalibrationSchema,
  nights: z.array(NightSchema),
  depth: DepthSchema,
  lpSim: LpSimSchema,
})

export type StudyRow = z.infer<typeof StudyRowSchema>
export type StudyMissing = z.infer<typeof StudyMissingSchema>
export type StudyNotPlayed = z.infer<typeof StudyNotPlayedSchema>
export type StudySnapshot = z.infer<typeof StudySnapshotSchema>

export interface StudySnapshotInput {
  generatedAt: string | null
  slot: number | null
  programIds: { horagon: string; pmAmm: string }
  rows: StudyRow[]
  missing: StudyMissing[]
  notPlayed: StudyNotPlayed[]
  lpSim: { seed: number; paths: number }
}

/** Six decimals: the curves and the simulation are illustrations, not records. */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6
const r6n = (x: number | null) => (x === null ? null : r6(x))

const byTipoff = (a: { tipoff: string; market: string }, b: { tipoff: string; market: string }) =>
  a.tipoff.localeCompare(b.tipoff) || a.market.localeCompare(b.market)

const samplesOf = (rows: readonly StudyRow[]) =>
  rows.map((r) => ({ p: r.initialPriceBps / 10_000, homeWon: r.outcome === 'home' }))

export function studySnapshot(input: StudySnapshotInput): StudySnapshot {
  const rows = [...input.rows].sort(byTipoff)
  const byNight = new Map<string, StudyRow[]>()
  for (const r of rows) byNight.set(r.night, [...(byNight.get(r.night) ?? []), r])
  const nights = [...byNight.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([night, list]) => {
      const c = calibration(samplesOf(list))
      return {
        night,
        n: c.n,
        brier: c.brier,
        logLoss: c.logLoss,
        upsets: c.upsets,
        counted: night >= FIRST_COUNTED_NIGHT,
      }
    })
  const sim = lpLossSim(input.lpSim.seed, input.lpSim.paths)
  return {
    schemaVersion: STUDY_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    slot: input.slot,
    programIds: input.programIds,
    firstCountedNight: FIRST_COUNTED_NIGHT,
    rows,
    missing: [...input.missing].sort(byTipoff),
    notPlayed: [...input.notPlayed].sort(byTipoff),
    calibration: calibration(samplesOf(rows)),
    nights,
    depth: {
      seedUsdc: REGULAR_SEED_USDC,
      createLeadSecs: CREATE_LEAD_SECS,
      medianFinalMinutes: MEDIAN_FINAL_MINUTES,
      curves: [END_OFFSET_SECS, END_OFFSET_BEFORE_R1_SECS].map((endOffsetSecs) => ({
        endOffsetSecs,
        points: depthCurve({ endOffsetSecs }).points.map((p) => ({
          minute: p.minute,
          depthShare: r6(p.depthShare),
          move10: r6n(p.move10),
          move100: r6n(p.move100),
        })),
      })),
    },
    lpSim: {
      ...sim,
      buckets: sim.buckets.map((b) => ({ ...b, loss: r6(b.loss), predicted: r6(b.predicted) })),
      totalLoss: r6(sim.totalLoss),
    },
  }
}
