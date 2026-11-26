// Tonight (Chronometer spec 4.1, R5): the hero and the live board. Rendered per request, so the
// first HTML holds tonight's games (lib/server/api.ts); the board then polls in the browser.
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { Hero } from '../components/chrono/hero'
import { TonightBoard } from '../components/tonight-board'
import { HOME_TITLE, SITE_DESCRIPTION } from '../lib/meta'
import { initialBoard } from '../lib/server/api'

export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: HOME_TITLE,
    description: SITE_DESCRIPTION,
    type: 'website',
    siteName: 'Horagon',
  },
  twitter: { title: HOME_TITLE, description: SITE_DESCRIPTION, card: 'summary_large_image' },
}

export default async function TonightPage() {
  // Per request: the board's data is live, and the build opens no DB or RPC connection.
  await connection()
  const initial = await initialBoard()
  return (
    <>
      <Hero />
      <TonightBoard initial={initial} />
    </>
  )
}
