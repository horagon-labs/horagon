// Arrow keys for the two keyboard paths (spec 2.6, 3.2): the bezel is a slider (up or right is
// one step more, PageUp/PageDown three), the Night dial a list (down or right is the next arc).
const SLIDER: Record<string, number> = {
  ArrowUp: 1,
  ArrowRight: 1,
  ArrowDown: -1,
  ArrowLeft: -1,
  PageUp: 3,
  PageDown: -3,
}
const LIST: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/** The index a key moves to, clamped to [0, count - 1]; null for a key that is not ours. */
export function keyStep(
  key: string,
  index: number,
  count: number,
  kind: 'slider' | 'list',
): number | null {
  if (count <= 0) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  const delta = (kind === 'slider' ? SLIDER : LIST)[key]
  if (delta === undefined) return null
  return Math.min(count - 1, Math.max(0, index + delta))
}
