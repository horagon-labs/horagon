'use client'
// Tonight (Chronometer spec 4.1): the live board. Games poll every 3 s as before; the positions
// that light arcs and rows are the wallet's own portfolio poll, so the board adds no request.
// The server's first frame (R5, lib/server/initial.ts) fills the board until the first poll
// answers, so the page never opens on "Setting the dial…" while the API is up. While no market is
// open, the server's idle face (the story card) takes the dial's slot.
import { type ReactNode, useEffect, useState } from 'react'
import { boardApi } from '../lib/api'
import { pollHealth } from '../lib/chrono/health'
import { useNow } from '../lib/chrono/now'
import { loadFollows, toggleFollow } from '../lib/follows'
import type { InitialBoard } from '../lib/server/initial'
import { usePoll } from '../lib/use-poll'
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
 * `idleFace` and `idleFoot`: the server-rendered story card and what follows it (first-screen W5),
 * shown in the dial's slot until the first market opens. `openFoot`: the compact story and the
 * Practice line, shown under the board once a market is open, so the poll swaps them in (G4).
 */
export function TonightBoard({
  initial,
  idleFace,
  idleFoot,
  openFoot,
}: {
  initial: InitialBoard
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

  return (
    <BoardView
      games={games.data ?? initial.games}
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
      idleFace={idleFace}
      idleFoot={idleFoot}
      openFoot={openFoot}
    />
  )
}
