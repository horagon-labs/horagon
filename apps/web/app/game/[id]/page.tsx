// A game (Chronometer spec 4.2): rendered per request, so the first HTML holds the game and its
// real price (R5, lib/server/api.ts); the page then polls in the browser.
import { connection } from 'next/server'
import { GameView } from '../../../components/game-view'
import { initialGame } from '../../../lib/server/api'

/** A malformed escape (`%E0%A4`) stays as typed; the API then answers that no such game exists. */
function decoded(id: string): string {
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await connection()
  const initial = await initialGame(decoded(id))
  return <GameView id={decoded(id)} initial={initial} />
}
