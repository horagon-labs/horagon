'use client'
// Tonight (Chronometer spec 4.1): the live board. Games poll every 3 s as before; the positions
// that light arcs and rows are the wallet's own portfolio poll, so the board adds no request.
// The server's first frame (R5, lib/server/initial.ts) fills the board until the first poll
// answers, so the page never opens on "Setting the dial…" while the API is up. While no market is
// open, the server's idle face (the story card) takes the dial's slot; once the poll has seen a
// market open, or a night over that the face does not tell, the Night dial keeps it for that
// server frame. When the frame stops fitting (the face gone, the night rolled over at 06:00 ET,
// or the ET date changed), the board asks the server for a new one, in place, once per frame.
import { type ReactNode, useEffect, useState } from 'react'
import { boardApi } from '../lib/api'
import { faceGone, frameKey, frameStale } from '../lib/chrono/board'
import { pollHealth } from '../lib/chrono/health'
import { useNow } from '../lib/chrono/now'
import { loadFollows, toggleFollow } from '../lib/follows'
import type { ScreenState } from '../lib/server/first-screen'
import type { InitialBoard } from '../lib/server/initial'
import { useLatch } from '../lib/use-latch'
import { usePoll } from '../lib/use-poll'
import { useRefresh } from '../lib/use-refresh'
import { BoardView } from './chrono/board-view'
import { useWallet } from './wallet'

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * `idleLead`: the Practice card while a run is on (first-screen S6), shown and dropped with the
 * face. `idleFace` and `idleFoot`: the server-rendered story card and what follows it (W5),
 * built for the server's `state`, shown in the dial's slot until they stop fitting what the poll
 * sees (lib/chrono/board.ts faceGone), and not again for that frame. `openFoot`: the compact story
 * and the Practice line, shown under the board once no idle face shows, so the poll swaps them in
 * (G4).
 */
export function TonightBoard({
  initial,
  state,
  idleLead,
  idleFace,
  idleFoot,
  openFoot,
}: {
  initial: InitialBoard
  /** The first-screen state the server picked (lib/server/first-screen.ts) and built the faces for. */
  state?: ScreenState
  idleLead?: ReactNode
  idleFace?: ReactNode
  idleFoot?: ReactNode
  openFoot?: ReactNode
}) {
  // Asks the server first each tick, so a market opening swaps the face within one poll (G4).
  const games = usePoll('games', () => boardApi.games.list())
  const { address, portfolio } = useWallet()
  // 0 while hydrating (lib/chrono/now.ts): the server's clock, so both renders match.
  const now = useNow() || initial.now
  const [follows, setFollows] = useState<string[]>([])
  // "Show all games" turns the follow filter off for this view only; a chip turns it back on.
  const [showAll, setShowAll] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  useEffect(() => setFollows(loadFollows(storage())), [])
  const shown = games.data ?? initial.games
  // The server built this frame for the state, ET night and ET date it saw. Once the faces stop
  // fitting what the poll sees (a market open, or a night over that they do not tell), they go and
  // stay gone for this frame (lib/use-latch.ts), so no face sits under "All stopped." that tells
  // another night. A frame that no longer fits is asked for again (lib/use-refresh.ts): the new
  // one comes with new props and a new key, so its faces show until they, in turn, stop fitting.
  const frame = { state, at: initial.now }
  const key = frameKey(frame)
  const gone = useLatch(faceGone(frame, shown, now), key)
  useRefresh(frameStale(frame, idleFace != null, shown, now), key)

  return (
    <BoardView
      games={shown}
      upcoming={initial.upcoming}
      portfolio={portfolio?.wallet === address ? portfolio : undefined}
      now={now}
      health={pollHealth(games)}
      follows={follows}
      onToggleFollow={(t) => {
        setFollows(toggleFollow(storage(), t))
        setShowAll(false)
      }}
      showAll={showAll}
      onShowAll={() => setShowAll(true)}
      selectedId={selectedId}
      onSelect={setSelectedId}
      hoverId={hoverId}
      onHover={setHoverId}
      idleLead={gone ? undefined : idleLead}
      idleFace={gone ? undefined : idleFace}
      idleFoot={gone ? undefined : idleFoot}
      openFoot={openFoot}
    />
  )
}
