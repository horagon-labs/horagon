import { describe, expect, it } from 'vitest'
import { FOLLOWS_KEY, loadFollows, toggleFollow } from '../lib/follows'

function store(initial?: string) {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(FOLLOWS_KEY, initial)
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

describe('follows', () => {
  it('toggles a team on and off and keeps it in storage', () => {
    const s = store()
    expect(toggleFollow(s, 'LAL')).toEqual(['LAL'])
    expect(toggleFollow(s, 'BOS')).toEqual(['LAL', 'BOS'])
    expect(toggleFollow(s, 'LAL')).toEqual(['BOS'])
    expect(loadFollows(s)).toEqual(['BOS'])
  })

  it('reads corrupt or foreign values as no follows', () => {
    for (const raw of ['{', '"LAL"', '{"team":"LAL"}', 'null']) {
      expect(loadFollows(store(raw))).toEqual([])
    }
    expect(loadFollows(store('["LAL",3,null,"BOS"]'))).toEqual(['LAL', 'BOS'])
  })

  it('still filters for this page view when storage is missing, blocked or full', () => {
    expect(loadFollows(null)).toEqual([])
    expect(toggleFollow(null, 'LAL')).toEqual(['LAL'])
    const blocked = {
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      },
    }
    expect(loadFollows(blocked)).toEqual([])
    expect(toggleFollow(blocked, 'LAL')).toEqual(['LAL'])
  })
})
