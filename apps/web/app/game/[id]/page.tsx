// A game (Chronometer spec 4.2): rendered per request, so the first HTML holds the game and its
// real price (R5, lib/server/api.ts); the page then polls in the browser. Its title and preview
// read "LAC @ MEM · MEM to win 62% · Horagon" (lib/meta.ts).
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { GameView } from '../../../components/game-view'
import { isPractice } from '../../../lib/chrono/practice'
import { fullTitle, gameMeta } from '../../../lib/meta'
import { initialGame, initialPractice } from '../../../lib/server/api'
import { decodedId } from './id'

type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  await connection()
  // The same cached first frame as the page below: one API call for both.
  const { game, now } = await initialGame(decodedId(id))
  const m = gameMeta(game, now)
  const shared = { title: fullTitle(m.title), description: m.description }
  return {
    title: m.title,
    description: m.description,
    openGraph: { ...shared, type: 'website', siteName: 'Horagon' },
    twitter: { ...shared, card: 'summary_large_image' },
  }
}

export default async function GamePage({ params }: Props) {
  const { id } = await params
  await connection()
  const initial = await initialGame(decodedId(id))
  // A Practice replay says who else trades it (R8), from the agent's heartbeat.
  const practice = initial.game && isPractice(initial.game) ? await initialPractice() : null
  return (
    <GameView id={decodedId(id)} initial={initial} counterparty={practice?.counterparty ?? null} />
  )
}
