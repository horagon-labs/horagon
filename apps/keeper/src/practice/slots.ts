// When a Practice run may start (R8): at 10, 12, 14, 16, 18 and 20:00 UTC, at most 6 a day. A
// run takes about 50 min from its start to the finalize, so two runs never overlap. Pure.

/** The UTC hours a run starts at. */
export const PRACTICE_SLOTS_UTC: readonly number[] = [10, 12, 14, 16, 18, 20]
/** A slot can still start this long after its time (a restart, a slow round), not later. */
export const PRACTICE_SLOT_GRACE_SECS = 600
/**
 * What a run occupies from its start: the market, the replayed game, the Final, the 15-min
 * window and the finalize, with margin. No NBA window may overlap it.
 */
export const PRACTICE_FOOTPRINT_SECS = 90 * 60

const DAY = 86_400

/** The slot starts of the UTC day that holds `now` (unix seconds). */
function slotsOfDay(now: number): number[] {
  const day = Math.floor(now / DAY) * DAY
  return PRACTICE_SLOTS_UTC.map((h) => day + h * 3600)
}

/** The slot whose start is at most PRACTICE_SLOT_GRACE_SECS before `now`, else null. */
export function dueSlot(now: number): number | null {
  return slotsOfDay(now).find((s) => now >= s && now < s + PRACTICE_SLOT_GRACE_SECS) ?? null
}

/** The next `count` slot starts strictly after `now`. */
export function nextSlots(now: number, count: number): number[] {
  const out: number[] = []
  for (let day = now; out.length < count; day += DAY) {
    for (const s of slotsOfDay(day)) if (s > now && out.length < count) out.push(s)
  }
  return out
}
