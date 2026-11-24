'use client'
// The right half of the game screen (spec 3.2, 4.2). The Pusher, the crown and the PositionCard
// share one useTrade, so Sell on the card turns that same crown to selling. On mobile a Pusher
// button opens the crown as a sheet; from 1024 px the crown sits under the Pusher, whose two
// buttons pick its side.
import type { GameDetail, MarketSummary, Side } from '@horagon/sdk'
import { useState } from 'react'
import { errorEffect } from '../../lib/chrono/errors'
import { useMedia, WIDE } from '../../lib/chrono/feel'
import { canTrade, type GameDial } from '../../lib/chrono/game'
import { pusherMode } from '../../lib/chrono/pusher'
import { BUY_AMOUNT, useTrade } from '../../lib/use-trade'
import { useWallet } from '../wallet'
import { CrownPanel } from './crown-panel'
import { CrownSheet } from './crown-sheet'
import { PositionCard } from './position-card'
import { Pusher } from './pusher'

/** This game's positions with the wallet's own Claim all run. */
export function GamePositions(p: {
  game: GameDetail
  canSell: boolean
  onSell: (side: Side) => void
}) {
  const { address, portfolio, startClaims, claiming, claimed, claimError } = useWallet()
  return (
    <PositionCard
      gameId={p.game.id}
      teams={{ home: p.game.home, away: p.game.away }}
      portfolio={portfolio?.wallet === address ? portfolio : undefined}
      canSell={p.canSell}
      onSell={p.onSell}
      claiming={claiming}
      claimed={claimed}
      claimError={claimError}
      onClaim={startClaims}
    />
  )
}

export function MarketBlock(p: {
  game: GameDetail
  market: MarketSummary
  dial: GameDial
  /** Unix seconds from useNow. */
  now: number
  /** MARKET_CLOSED or MARKET_HALTED: reload the game (spec 6.1). */
  onMarketStale: () => void
}) {
  const t = useTrade(p.game, p.market, { onMarketStale: p.onMarketStale })
  const { address, portfolio, requestFaucet, funding, fundNote } = useWallet()
  const wide = useMedia(WIDE)
  const [open, setOpen] = useState(false)
  const trading = canTrade(p.dial.state)
  const mode = pusherMode({
    state: p.dial.state,
    ready: t.ready,
    balance: t.balance,
    effect: errorEffect(t.error),
    secsLeft: p.dial.secsLeft,
  })
  const pick = (side: Side) => {
    t.setSide(side)
    // A sell's share count must never become a buy amount in mUSDC.
    if (t.action === 'sell') t.setAmount(BUY_AMOUNT)
    t.setAction('buy')
    if (!wide) setOpen(true)
  }
  const sell = (side: Side) => {
    const mine = portfolio?.wallet === address ? portfolio : undefined
    const held = mine?.positions.find((x) => x.market === p.market.pubkey && x.side === side)
    t.setSide(side)
    t.setAction('sell')
    t.setAmount(held?.shares ?? '')
    if (!wide) setOpen(true)
  }
  const crown = (
    <CrownPanel
      trade={t}
      game={p.game}
      market={p.market}
      state={p.dial.state}
      timeLeft={p.dial.timeLeft}
      now={p.now}
      funding={funding}
      fundNote={fundNote}
      onFaucet={requestFaucet}
    />
  )
  return (
    <>
      <section aria-label="Trade" className="space-y-4" data-block="crown">
        <Pusher
          mode={mode}
          home={p.game.home}
          away={p.game.away}
          price={p.market.price}
          onPick={pick}
          selected={wide ? (t.action === 'buy' ? t.side : null) : undefined}
          funding={funding}
          onFaucet={requestFaucet}
        />
        {wide && trading && crown}
      </section>
      {!wide && (
        <CrownSheet
          open={open && trading}
          onClose={() => setOpen(false)}
          title={`${t.action === 'buy' ? 'Buy' : 'Sell'} ${t.team}`}
        >
          {crown}
        </CrownSheet>
      )}
      <GamePositions game={p.game} canSell={trading} onSell={sell} />
    </>
  )
}
