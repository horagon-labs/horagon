// Followed teams live in the browser only in Tier 1 (the `follows` table comes with push).
export const FOLLOWS_KEY = 'horagon.follows.v1'

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function loadFollows(store: Store | null): string[] {
  try {
    const raw = store?.getItem(FOLLOWS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

export function toggleFollow(store: Store | null, team: string): string[] {
  const current = loadFollows(store)
  const next = current.includes(team) ? current.filter((t) => t !== team) : [...current, team]
  try {
    store?.setItem(FOLLOWS_KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: the filter still works for this page view.
  }
  return next
}
