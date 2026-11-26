import type { GameWithMarkets } from '@horagon/db'
import { describe, expect, it } from 'vitest'
import { deployBlockers, deployCheckLines } from '../src/ops/deploy-check'

const S = 1_795_000_000

/** A game tipping off at `tip`, with a winner market in `market` state (null: none yet). */
function game(
  id: string,
  o: { tip?: number; status?: string; market?: string | null; kind?: number },
): GameWithMarkets {
  const market = o.market === undefined ? 'open' : o.market
  return {
    id,
    away: 'MEM',
    home: 'CLE',
    scheduledTipoff: new Date((o.tip ?? S) * 1000),
    status: o.status ?? 'live',
    markets: market === null ? [] : [{ kind: o.kind ?? 0, status: market }],
  } as unknown as GameWithMarkets
}

const ids = (games: GameWithMarkets[], now: number) =>
  deployBlockers(games, now).map((b) => b.gameId)

describe('deployBlockers', () => {
  it('blocks from tip-off - 60 min, before the market exists', () => {
    const g = game('nba-1', { status: 'scheduled', market: null })
    expect(ids([g], S - 3_601)).toEqual([])
    expect(ids([g], S - 3_600)).toEqual(['nba-1'])
    // No market by S + 30 min: the keeper no longer creates one, nothing to protect.
    expect(ids([g], S + 1_799)).toEqual(['nba-1'])
    expect(ids([g], S + 1_800)).toEqual([])
    // A game under way with no market: nothing the restart can hold back.
    expect(ids([game('nba-2', { status: 'live', market: null })], S + 600)).toEqual([])
  })

  it('blocks while the market is open, or halted on a live or final game', () => {
    const now = S + 7_000
    expect(ids([game('open', { market: 'open', status: 'scheduled' })], S - 1_000)).toEqual([
      'open',
    ])
    expect(ids([game('open', { market: 'open' })], now)).toEqual(['open'])
    // The buzzer halt waits for its draft and the guardian's propose; a feed-silent halt waits
    // for the game to end.
    expect(ids([game('final', { market: 'halted', status: 'final' })], now)).toEqual(['final'])
    expect(ids([game('silent', { market: 'halted', status: 'live' })], now)).toEqual(['silent'])
  })

  it('lets the deploy go once the market has a result, or waits days for a NO', () => {
    const now = S + 12_000
    for (const market of ['proposed', 'challenged', 'finalized', 'recycled']) {
      expect(ids([game(market, { market, status: 'final' })], now), market).toEqual([])
    }
    // Halted on a game that was not played: its NO result comes 7 days later.
    for (const status of ['postponed', 'canceled', 'scheduled']) {
      expect(ids([game(status, { market: 'halted', status })], now), status).toEqual([])
    }
    // Only the winner market counts.
    expect(ids([game('kind1', { market: 'open', kind: 1, status: 'final' })], now)).toEqual([])
  })

  it('lists every blocker by tip-off, and says so', () => {
    const now = S + 600
    const games = [
      game('late', { tip: S + 1_800, status: 'scheduled', market: 'open' }),
      game('early', { tip: S, market: 'open' }),
      game('done', { tip: S - 20_000, market: 'recycled', status: 'final' }),
      game('later', { tip: S + 7_200, status: 'scheduled', market: null }),
    ]
    const blockers = deployBlockers(games, now)
    expect(blockers.map((b) => b.gameId)).toEqual(['early', 'late'])
    expect(deployCheckLines(blockers, now)).toEqual([
      `blocked at ${new Date(now * 1000).toISOString()}: 2 games are between tip-off - 60 min and the close of their market`,
      `  early  MEM@CLE  tip-off ${new Date(S * 1000).toISOString()}  game:live  market:open`,
      `  late  MEM@CLE  tip-off ${new Date((S + 1_800) * 1000).toISOString()}  game:scheduled  market:open`,
    ])
    expect(deployCheckLines([], now)).toEqual([
      `clear at ${new Date(now * 1000).toISOString()}: no game is between tip-off - 60 min and the close of its market`,
    ])
    const one = deployBlockers([game('x', { status: 'scheduled', market: null })], S - 60)
    expect(deployCheckLines(one, S - 60)[0]).toContain('1 game is between')
    expect(deployCheckLines(one, S - 60)[1]).toContain('no market yet')
  })
})
