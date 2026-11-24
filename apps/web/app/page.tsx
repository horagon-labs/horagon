'use client'
// Tonight (Chronometer spec 4.1): the live board. Games poll every 3 s as before; the positions
// that light arcs and rows are the wallet's own portfolio poll, so the board adds no request.
import { useEffect, useState } from 'react'
import { BoardView } from '../components/chrono/board-view'
import { useWallet } from '../components/wallet'
import { api } from '../lib/api'
import { pollHealth } from '../lib/chrono/health'
import { useNow } from '../lib/chrono/now'
import { loadFollows, toggleFollow } from '../lib/follows'
import { usePoll } from '../lib/use-poll'

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export default function TonightPage() {
  const games = usePoll('games', () => api.games.list())
  const { address, portfolio } = useWallet()
  const now = useNow()
  const [follows, setFollows] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  useEffect(() => setFollows(loadFollows(storage())), [])

  return (
    <BoardView
      games={games.data}
      portfolio={portfolio?.wallet === address ? portfolio : undefined}
      now={now}
      health={pollHealth(games)}
      follows={follows}
      onToggleFollow={(t) => setFollows(toggleFollow(storage(), t))}
      selectedId={selectedId}
      onSelect={setSelectedId}
      hoverId={hoverId}
      onHover={setHoverId}
    />
  )
}
