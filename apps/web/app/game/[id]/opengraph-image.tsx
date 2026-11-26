// A game's link preview (R5): the gauge at the live price, the matchup, the score or the tip-off
// and the play-money line. Drawn per request from the same first-frame data as the page.
import { ImageResponse } from 'next/og'
import { HERO_LINE } from '../../../components/chrono/hero'
import { CARD_SIZE, ShareCard } from '../../../components/share-card'
import { gameCard } from '../../../lib/meta'
import { initialGame } from '../../../lib/server/api'
import { decodedId } from './id'

export const alt = 'A Horagon game: the matchup, the score and the price to win'
export const size = CARD_SIZE
export const contentType = 'image/png'
export const dynamic = 'force-dynamic'

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { game, now } = await initialGame(decodedId(id))
  if (!game) {
    // The API did not answer in time, or there is no such game: the brand card, no needle.
    return new ImageResponse(
      <ShareCard title="Game-day NBA markets" line={HERO_LINE} price={null} />,
      size,
    )
  }
  const card = gameCard(game, now)
  return new ImageResponse(
    <ShareCard
      title={card.matchup}
      line={card.line}
      headline={card.headline}
      price={card.price}
      live={card.live}
    />,
    size,
  )
}
