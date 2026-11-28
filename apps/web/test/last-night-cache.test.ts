// Slice 5 review finding 2: once the night rolls over at 06:00 ET the board asks the server for a
// new frame (router.refresh), and that frame must tell the night that has just become last night.
// R10's loader kept its answer for 60 s under one key, so a frame rendered in the first minute
// after 06:00 ET could still get the night before. The answer is now kept per ET night.
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialLastNight } from '../lib/server/api'
import { type LastNight, loadLastNight } from '../lib/server/last-night'

vi.mock('../lib/server/last-night', async (actual) => ({
  ...(await actual<typeof import('../lib/server/last-night')>()),
  loadLastNight: vi.fn(),
}))

const night = (date: string): LastNight => ({ date, rows: [], upsets: 0 })
const load = loadLastNight as unknown as Mock

describe('initialLastNight keeps its answer per ET night', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // The newest final night before the ET night of `now` (06:00 ET rollover).
    load.mockImplementation(async (_client: unknown, now: number) =>
      night(now < Date.parse('2026-11-28T11:00:00Z') / 1000 ? '2026-11-26' : '2026-11-27'),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    load.mockReset()
  })

  it('shares one answer within a night, and asks again once the night rolls over', async () => {
    // Saturday 05:59:30 ET: the night is still Friday's, so last night is Thursday.
    vi.setSystemTime(new Date('2026-11-28T10:59:30Z'))
    expect((await initialLastNight())?.date).toBe('2026-11-26')
    vi.setSystemTime(new Date('2026-11-28T10:59:50Z'))
    expect((await initialLastNight())?.date).toBe('2026-11-26')
    expect(load).toHaveBeenCalledTimes(1)
    // 06:00:10 ET, 40 s later: Friday is last night now, within the old 60 s.
    vi.setSystemTime(new Date('2026-11-28T11:00:10Z'))
    expect((await initialLastNight())?.date).toBe('2026-11-27')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
