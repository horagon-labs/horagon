// Dev-only gallery of every Chronometer state, for the screenshots of spec 6.2 when no live
// market is in that state. A production build answers 404 here.
import { notFound } from 'next/navigation'
import { Gallery } from '../../../components/chrono/gallery'
import { LastNightStrip } from '../../../components/last-night'
import { at, game, market } from '../../../lib/chrono/fixtures'
import { nightRows } from '../../../lib/server/last-night'

/** "Last night on the dial" (R10) from a fixture night: two upsets, an overtime, a null close. */
function lastNightFixture() {
  const final = (
    id: string,
    home: [string, number],
    away: [string, number],
    bps: number,
    price: number | null,
    period = 4,
  ) =>
    game({
      id,
      home: home[0],
      homeScore: home[1],
      away: away[0],
      awayScore: away[1],
      status: 'final',
      period,
      clockSecs: null,
      scheduledTipoff: new Date(at('2026-11-26T00:30:00Z') * 1000).toISOString(),
      markets: [market({ pubkey: `Mkt${id}`, status: 'finalized', initialPriceBps: bps, price })],
    })
  const { rows, upsets } = nightRows([
    final('nba-1', ['CHA', 105], ['CHI', 107], 7_400, 0.19),
    final('nba-2', ['MIN', 99], ['LAL', 98], 2_800, 0.86),
    final('nba-3', ['DEN', 120], ['PHX', 118], 5_500, 0.93, 5),
    final('nba-4', ['NYK', 110], ['BOS', 90], 6_100, null),
    final('nba-5', ['MIA', 101], ['ORL', 100], 6_500, 0.71),
  ])
  return { date: '2026-11-25', rows, upsets }
}

export default function ChronoGalleryPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return (
    <>
      <Gallery />
      <div className="mt-10" data-dev-last-night>
        <LastNightStrip night={lastNightFixture()} />
      </div>
    </>
  )
}
