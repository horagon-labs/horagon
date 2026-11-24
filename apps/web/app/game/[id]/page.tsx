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
  // The old game screen keeps its one-column width until wave 2 (Chronometer spec 6.3).
  return (
    <div className="mx-auto max-w-2xl">
      <GameView id={decoded(id)} />
    </div>
  )
}
