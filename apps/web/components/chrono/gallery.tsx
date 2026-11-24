'use client'
// The dev-only state gallery (app/dev/chrono): every DialState, the board's shared states and
// the game screen's, drawn from the fixtures at 9:08 PM ET, so each one can be screenshotted
// (spec 6.2). The crown and the Pusher are drawn here from a stub trade that sends nothing, so
// the bezel and the HoldButton can be tried by keyboard and pointer; the live send path was
// verified in the Task 24 e2e run.
import type { Game, Side, TradeAction } from '@horagon/sdk'
import { type ReactNode, useState } from 'react'
import {
  detail,
  evening,
  game,
  history,
  market,
  NOW,
  portfolio,
  position,
  quote,
} from '../../lib/chrono/fixtures'
import { gameDial } from '../../lib/chrono/game'
import type { Health } from '../../lib/chrono/health'
import { type PusherInput, pusherMode } from '../../lib/chrono/pusher'
import { DIAL_STATES, type DialState, dialLabel } from '../../lib/chrono/state'
import { checkTrade } from '../../lib/trade-form'
import { BUY_AMOUNT, startAmount } from '../../lib/trade-view'
import type { Trade } from '../../lib/use-trade'
import { BoardView } from './board-view'
import { CrownPanel } from './crown-panel'
import { CrownSheet } from './crown-sheet'
import { Dial } from './dial'
import { stateLine } from './dial-look'
import { GameLoading, GameScreen, NoGame } from './game-screen'
import { MiniDial } from './mini-dial'
import { PositionCard } from './position-card'
import { Pusher } from './pusher'

interface Sample {
  price: number | null
  timeLeft: number
  secsLeft: number | null
  game: Game
}

const live = game()
const later = game({ status: 'scheduled', scheduledTipoff: '2026-11-25T03:30:00Z' })

const SAMPLES: Record<DialState, Sample> = {
  resolved: { price: 1, timeLeft: 0, secsLeft: 0, game: game({ status: 'final' }) },
  challenged: { price: 0.97, timeLeft: 0, secsLeft: 0, game: game({ status: 'final' }) },
  proposed: { price: 1, timeLeft: 0, secsLeft: 0, game: game({ status: 'final' }) },
  void: { price: null, timeLeft: 0, secsLeft: null, game: game({ status: 'postponed' }) },
  halted: { price: 0.62, timeLeft: 0.4, secsLeft: 2_400, game: live },
  closed: { price: 0.88, timeLeft: 0, secsLeft: 0, game: game({ status: 'final' }) },
  closing: { price: 0.41, timeLeft: 0.02, secsLeft: 252, game: live },
  live: { price: 0.77, timeLeft: 0.33, secsLeft: 3_730, game: live },
  pre: { price: 0.55, timeLeft: 1, secsLeft: 9_000, game: later },
}

const OK: Health = { stale: false, error: undefined }
const STALE: Health = { stale: true, error: undefined }
const DOWN: Health = { stale: true, error: new Error('down') }

function Section(p: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-11 uppercase tracking-[0.3em] text-brass-500">{p.title}</h2>
      {p.children}
    </section>
  )
}

function Board(p: { games: Game[] | undefined; health: Health }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [follows, setFollows] = useState<string[]>([])
  return (
    <BoardView
      games={p.games}
      portfolio={portfolio([position()])}
      now={NOW}
      health={p.health}
      follows={follows}
      onToggleFollow={(t) =>
        setFollows((f) => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t]))
      }
      selectedId={selectedId}
      onSelect={setSelectedId}
      hoverId={hoverId}
      onHover={setHoverId}
    />
  )
}

function GameSample({ stale }: { stale: boolean }) {
  const noop = () => {}
  return (
    <GameScreen
      game={detail()}
      history={history()}
      dial={gameDial(game(), market(), NOW - 3_730, null, NOW)}
      now={NOW}
      stale={stale}
      right={
        <PositionCard
          gameId={game().id}
          teams={{ home: 'CLE', away: 'MEM' }}
          portfolio={portfolio([position()])}
          canSell
          onSell={noop}
          claiming={false}
          claimed={[]}
          claimError={undefined}
          onClaim={noop}
        />
      }
    />
  )
}

const DEMO_BALANCE = '493.74'

/**
 * A Trade as useTrade returns it, for a ready wallet holding CLE shares, with the real step
 * ladder and form checks. `send` only counts: no api, no wallet, no network.
 */
function useDemoTrade(): Trade & { sent: number } {
  const [side, setSide] = useState<Side>('home')
  const [action, setAction] = useState<TradeAction>('buy')
  const [amount, setAmount] = useState(BUY_AMOUNT)
  const [sent, setSent] = useState(0)
  const g = detail()
  const m = market()
  const positionOn = (s: Side) => (s === 'home' ? position() : undefined)
  const held = positionOn(side)
  const q = quote()
  return {
    side,
    action,
    setDirection: (next, nextSide = side) => {
      const to = { action: next, side: nextSide }
      setAmount(startAmount(to, { action, side, amount }, positionOn(nextSide)?.shares))
      setSide(nextSide)
      setAction(next)
    },
    amount,
    setAmount,
    team: side === 'home' ? g.home : g.away,
    ready: 'ready',
    held,
    balance: DEMO_BALANCE,
    check: checkTrade({
      action,
      amount,
      balance: DEMO_BALANCE,
      shares: held?.shares,
      marketStatus: m.status,
      endTs: m.endTs,
      nowSecs: NOW,
    }),
    quote: { data: q, error: undefined, failures: 0, refresh: () => {} },
    lastQuote: q,
    quotePending: false,
    stage: null,
    done: null,
    error: undefined,
    errorAt: 0,
    failedAction: 'buy',
    shownError: undefined,
    fundNoteHidden: true,
    send: () => setSent((n) => n + 1),
    sent,
  }
}

function CrownDemo() {
  const t = useDemoTrade()
  const [open, setOpen] = useState(false)
  const dial = gameDial(game(), market(), NOW - 3_730, null, NOW)
  const panel = (
    <CrownPanel
      trade={t}
      game={detail()}
      market={market()}
      state="live"
      timeLeft={dial.timeLeft}
      now={NOW}
      funding={false}
      fundNote={undefined}
      onFaucet={() => {}}
    />
  )
  return (
    <div className="max-w-sm space-y-3">
      {panel}
      <p className="text-13 text-ash-400">Demo sends: {t.sent}</p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 rounded-card border border-line px-4 text-13"
      >
        Open the crown sheet
      </button>
      <CrownSheet
        open={open}
        onClose={() => setOpen(false)}
        title={`${t.action === 'buy' ? 'Buy' : 'Sell'} ${t.team}`}
      >
        {panel}
      </CrownSheet>
    </div>
  )
}

/** The Pusher's modes as pusherMode gives them for each input. */
const PUSHER_BASE: PusherInput = {
  state: 'live',
  ready: 'ready',
  balance: DEMO_BALANCE,
  effect: null,
  failedAction: 'buy',
  secsLeft: 3_730,
}
const PUSHER_SAMPLES: [string, Partial<PusherInput>][] = [
  ['live', {}],
  ['closing', { state: 'closing', secsLeft: 252 }],
  ['halted', { state: 'halted' }],
  ['no wallet', { ready: 'no-wallet', balance: undefined }],
  ['closed', { state: 'closed', secsLeft: 0 }],
]

export function Gallery() {
  return (
    <div className="space-y-10 pb-10">
      <Section title="Dial states (spec 4.3)">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {DIAL_STATES.map((state) => {
            const s = SAMPLES[state]
            return (
              <figure key={state} className="space-y-1">
                <Dial
                  price={s.price}
                  modelProb={0.74}
                  timeLeft={s.timeLeft}
                  state={state}
                  team="CLE"
                  liveDot={s.game.status === 'live'}
                  detail={stateLine(state, s.game, s.secsLeft, NOW)}
                  label={dialLabel({
                    team: 'CLE',
                    price: s.price,
                    modelProb: 0.74,
                    state,
                    secsLeft: s.secsLeft,
                    gameStatus: s.game.status,
                  })}
                />
                <figcaption className="text-center font-mono text-11 text-ash-400">
                  {state}
                </figcaption>
              </figure>
            )
          })}
        </div>
      </Section>
      <Section title="Loading, stale, ghost (spec 4.4, 5.5)">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Dial
            loading
            price={null}
            modelProb={null}
            timeLeft={1}
            state="pre"
            team="CLE"
            label="Loading"
          />
          <Dial
            stale
            price={0.77}
            modelProb={0.74}
            timeLeft={0.33}
            state="live"
            team="CLE"
            label="Stale"
          />
          <Dial
            ghostPrice={0.81}
            price={0.77}
            modelProb={0.74}
            timeLeft={0.33}
            state="live"
            team="CLE"
            label="Ghost"
          />
        </div>
      </Section>
      <Section title="MiniDial">
        <div className="flex flex-wrap gap-3">
          {DIAL_STATES.map((state) => (
            <MiniDial
              key={state}
              price={SAMPLES[state].price}
              timeLeft={SAMPLES[state].timeLeft}
              state={state}
              held={state === 'live'}
            />
          ))}
        </div>
      </Section>
      <Section title="Board">
        <Board games={evening()} health={OK} />
      </Section>
      <Section title="Board loading">
        <Board games={undefined} health={OK} />
      </Section>
      <Section title="Board empty">
        <Board games={[]} health={OK} />
      </Section>
      <Section title="Board stale">
        <Board games={evening()} health={STALE} />
      </Section>
      <Section title="Board error after three failures">
        <Board games={undefined} health={DOWN} />
      </Section>
      <Section title="Game screen">
        <GameSample stale={false} />
      </Section>
      <Section title="Game screen stale">
        <GameSample stale />
      </Section>
      <Section title="Game loading and no game">
        <div className="grid grid-cols-2 gap-4">
          <GameLoading stale={false} />
          <NoGame />
        </div>
      </Section>
      <Section title="Pusher (spec 3.2, 4.3)">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PUSHER_SAMPLES.map(([name, over]) => (
            <figure key={name} className="space-y-1">
              <Pusher
                mode={pusherMode({ ...PUSHER_BASE, ...over })}
                home="CLE"
                away="MEM"
                price={0.77}
                onPick={() => {}}
                funding={false}
                onFaucet={() => {}}
              />
              <figcaption className="text-center font-mono text-11 text-ash-400">{name}</figcaption>
            </figure>
          ))}
        </div>
      </Section>
      <Section title="Crown, from a stub trade (spec 3.2, 5.5)">
        <CrownDemo />
      </Section>
    </div>
  )
}
