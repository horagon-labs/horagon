// Pure helpers for `horagon-ops`, kept apart from the CLI glue so they are unit tested.

/** "112-108" (home-away) to [112, 108]. */
export function parseScore(raw: string): [number, number] {
  const m = /^(\d{1,3})-(\d{1,3})$/.exec(raw.trim())
  if (!m) throw new Error(`--score must look like 112-108 (home-away), got "${raw}"`)
  return [Number(m[1]), Number(m[2])]
}

/** "30-25,28-27,26-30,27-24" (home-away per period, OT included). */
export function parsePeriods(raw: string): Array<[number, number]> {
  const periods = raw.split(',').map((p) => parseScore(p))
  if (periods.length < 4 || periods.length > 12) throw new Error('--periods needs 4 to 12 periods')
  return periods
}

/** A SOL amount to lamports, refusing silly amounts. */
export function solToLamports(raw: string, max = 10): number {
  const sol = Number(raw)
  if (!Number.isFinite(sol) || sol <= 0 || sol > max)
    throw new Error(`amount must be in (0, ${max}] SOL`)
  return Math.round(sol * 1e9)
}

/** Whether a keeper heartbeat this old should page, given the games around now (spec 7). */
export function heartbeatStale(
  ageSecs: number | null,
  tipoffs: readonly number[],
  nowSecs: number,
  maxAgeSecs = 120,
): boolean {
  const gameNight = tipoffs.some((t) => nowSecs >= t - 90 * 60 && nowSecs <= t + 4 * 3600)
  return gameNight && (ageSecs === null || ageSecs > maxAgeSecs)
}
