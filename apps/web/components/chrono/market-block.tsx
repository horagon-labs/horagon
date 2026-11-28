'use client'
// The right half of the game screen (spec 3.2, 4.2). The Pusher, the crown and the PositionCard
// share one useTrade, so Sell on the card turns that same crown to selling. On mobile a Pusher
// button opens the crown as a sheet; from 1024 px the crown sits under the Pusher, whose two
// buttons pick its side.
import type { GameDetail, MarketSummary, Side } from '@horagon/sdk'
import { useState } from 'react'
import { started } from '../../lib/chrono/copy'
import { errorEffect } from '../../lib/chrono/errors'
import { useMedia, WIDE } from '../../lib/chrono/feel'
import { canTrade, crownShown, type GameDial } from '../../lib/chrono/game'
import { pusherMode } from '../../lib/chrono/pusher'
import { useTrade } from '../../lib/use-trade'
import { useWallet } from '../wallet'
import { CrownPanel } from './crown-panel'
import { CrownSheet } from './crown-sheet'
import { PositionCard } from './position-card'
import { Pusher } from './pusher'

/** The price at the horn: the last price once trading stopped, before any result. */
const horn = (state: GameDial['state'], price: number | null): number | null =>
  state === 'closed' || state === 'proposed' || state === 'challenged' ? price : null

/** This game's positions with the wallet's own Claim all run. */
export function GamePositions(p: {
  game: GameDetail
  canSell: boolean
  onSell: (side: Side) => void
  /** The home side's price at the horn, once trading stopped; null while it trades. */
  hornPrice?: number | null
}) {
  const { address, portfolio, startClaims, claiming, claimed, claimError, preparing } = useWallet()
  return (
    <PositionCard
      gameId={p.game.id}
      teams={{ home: p.game.home, away: p.game.away }}
      portfolio={portfolio?.wallet === address ? portfolio : undefined}
      canSell={p.canSell}
      onSell={p.onSell}
      claiming={claiming}
      preparing={preparing}
      claimed={claimed}
      claimError={claimError}
      onClaim={startClaims}
      hornPrice={p.hornPrice ?? null}
      final={p.game.status === 'final'}
    />
  )
}

export function MarketBlock(p: {
  game: GameDetail
  market: MarketSummary
  dial: GameDial
  /** Unix seconds from useNow. */
  now: number
  /** The game poll is failing (spec 4.4), for the crown's own dial and, in the sheet, its line. */
  stale: boolean
  /** MARKET_CLOSED or MARKET_HALTED: reload the game (spec 6.1). */
  onMarketStale: () => void
}) {
  const t = useTrade(p.game, p.market, { onMarketStale: p.onMarketStale })
  const { requestFaucet, funding, fundNote, preparing, prepare } = useWallet()
  const wide = useMedia(WIDE)
  const [open, setOpen] = useState(false)
  const trading = canTrade(p.dial.state)
  // A send in flight, or its result, keeps the crown when the market closes or halts under it.
  const shown = crownShown(p.dial.state, t)
  const mode = pusherMode({
    state: p.dial.state,
    ready: t.ready,
    balance: t.balance,
    effect: errorEffect(t.error),
    failedAction: t.failedAction,
    secsLeft: p.dial.secsLeft,
    started: started(p.game),
    close: p.game,
  })
  // setDirection sets the amount too: a sell's share count never becomes a buy amount in mUSDC.
  const pick = (side: Side) => {
    t.setDirection('buy', side)
    if (!wide) setOpen(true)
  }
  const sell = (side: Side) => {
    t.setDirection('sell', side)
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
      preparing={preparing}
      onIntent={prepare}
      fundNote={fundNote}
      onFaucet={requestFaucet}
      stale={p.stale}
      staleLine={p.stale && !wide}
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
          preparing={preparing}
          onFaucet={requestFaucet}
        />
        {wide && shown && crown}
      </section>
      {!wide && (
        <CrownSheet
          open={open && shown}
          onClose={() => setOpen(false)}
          title={`${t.action === 'buy' ? 'Back' : 'Sell'} ${t.team}`}
        >
          {crown}
        </CrownSheet>
      )}
      <GamePositions
        game={p.game}
        canSell={trading}
        onSell={sell}
        hornPrice={horn(p.dial.state, p.market.price)}
      />
    </>
  )
}
