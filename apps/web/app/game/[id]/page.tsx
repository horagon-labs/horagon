import { GameView } from '../../../components/game-view'

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
  return <GameView id={decoded(id)} />
}
