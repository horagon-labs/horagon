// The link preview of / (R5): the brand gauge and what Horagon is. No data, so it is built once.
import { ImageResponse } from 'next/og'
import { HERO_LINE } from '../components/chrono/hero'
import { CARD_SIZE, ShareCard } from '../components/share-card'

export const alt = 'Horagon: game-day NBA markets, play money on Solana devnet'
export const size = CARD_SIZE
export const contentType = 'image/png'

// The brand needle of app/icon.svg points at 45 degrees: two thirds of the scale.
const BRAND_PRICE = 2 / 3

export default function Image() {
  return new ImageResponse(
    <ShareCard title="Game-day NBA markets" line={HERO_LINE} price={BRAND_PRICE} />,
    size,
  )
}
