// Tonight (Chronometer spec 4.1, R5): the hero and the live board. Rendered per request, so the
// first HTML holds tonight's games (lib/server/api.ts); the board then polls in the browser.
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { Hero } from '../components/chrono/hero'
import { TonightBoard } from '../components/tonight-board'
import { initialBoard } from '../lib/server/api'

export const metadata: Metadata = {
  title: { absolute: "Horagon · Tonight's NBA games, live" },
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
