'use client'
// The crown's content (spec 3.2, 5.5): the bezel around a dial whose ghost needle follows the
// newest quote, the numbers, presets and the amount field, and the HoldButton. It only draws a
// Trade from useTrade; the same panel is the mobile sheet and the desktop right column.
import type { GameDetail, MarketSummary } from '@horagon/sdk'
import { buySteps, percentOf, sellSteps, stepIndex } from '../../lib/chrono/bezel'
import { errorEffect, retryLeft } from '../../lib/chrono/errors'
import type { DialState } from '../../lib/chrono/state'
import { cents, explorerTx, usdc } from '../../lib/format'
import { DEFAULT_SLIPPAGE_BPS } from '../../lib/trade'
import { sendDisabled, sendText } from '../../lib/trade-view'
import type { Trade } from '../../lib/use-trade'
import { ErrorText } from '../error-text'
import { Bezel } from './bezel'
import { Dial } from './dial'
import { HoldButton } from './hold-button'

const BUY_PRESETS = ['10', '25', '50', '100'] as const
const SELL_PRESETS = [25, 50, 100] as const

export interface CrownPanelProps {
  trade: Trade
  game: GameDetail
  market: MarketSummary
  state: DialState
  timeLeft: number
  /** Unix seconds from useNow, for the RATE_LIMITED countdown. */
  now: number
  funding: boolean
  fundNote: string | undefined
  onFaucet: () => void
}

export function CrownPanel(p: CrownPanelProps) {
  const t = p.trade
  const buying = t.action === 'buy'
  const steps = buying ? buySteps(t.balance) : sellSteps(t.held?.shares)
  const q = t.quote.data ?? t.lastQuote
  const effect = errorEffect(t.error)
  const wait = effect === 'countdown' ? retryLeft(t.error, t.errorAt, p.now) : 0
  const label = wait > 0 ? `Try again in ${wait} s` : sendText(t.ready, t.stage, t.action, t.team)
  const ghost = q && t.check.quote ? q.priceAfter : null
  const spoken = (x: number) => cents(x).replace('¢', ' cents')
  const now = p.market.price === null ? 'no price yet' : spoken(p.market.price)
  const chip =
    'min-h-11 flex-1 rounded-card border border-line font-mono text-13 aria-pressed:border-lume-300 aria-pressed:text-lume-300 disabled:opacity-40'
  return (
    <div className="space-y-4">
      <fieldset className="flex gap-2">
        <legend className="sr-only">Buy or sell</legend>
        <button
          type="button"
          aria-pressed={buying}
          onClick={() => t.setAction('buy')}
          className={chip}
        >
          Buy {t.team}
        </button>
        <button
          type="button"
          aria-pressed={!buying}
          disabled={!t.held}
          onClick={() => t.setAction('sell')}
          className={chip}
        >
          Sell {t.team}
        </button>
      </fieldset>
      <Bezel
        steps={steps}
        index={stepIndex(steps, t.amount)}
        onChange={(i) => {
          const s = steps[i]
          if (s) t.setAmount(s.amount)
        }}
        label={buying ? 'mUSDC to spend' : 'Shares to sell'}
        className="mx-auto max-w-80"
      >
        <Dial
          price={p.market.price}
          modelProb={p.game.modelProb}
          timeLeft={p.timeLeft}
          state={p.state}
          team={p.game.home}
          ghostPrice={ghost}
          ghostPending={t.quotePending}
          ghostShake={effect === 'requote'}
          detail={buying ? `${t.amount} mUSDC` : `${t.amount} shares`}
          label={`${p.game.home} wins, ${now}${ghost === null ? '' : `, after this trade ${spoken(ghost)}`}`}
        />
      </Bezel>
      {q && t.check.quote && (
        <dl className="grid grid-cols-2 gap-y-1 font-mono text-13 tabular-nums">
          <dt className="font-sans text-ash-400">
            {buying ? 'Shares received' : 'mUSDC received'}
          </dt>
          <dd className="text-right">{usdc(q.amountOut)}</dd>
          <dt className="font-sans text-ash-400">Average price</dt>
          <dd className="text-right">{cents(q.avgPrice)}</dd>
          {buying && (
            <>
              <dt className="font-sans text-ash-400">If {t.team} wins</dt>
              <dd className="text-right">{usdc(q.amountOut)} mUSDC</dd>
            </>
          )}
          <dt className="font-sans text-ash-400">Price impact</dt>
          <dd className="text-right text-amber-400">{(q.priceImpactBps / 100).toFixed(2)}%</dd>
          <dt className="font-sans text-ash-400">Fee (2%)</dt>
          <dd className="text-right">{usdc(q.feeUsdc)} mUSDC</dd>
          <dt className="font-sans text-ash-400">Max slippage {DEFAULT_SLIPPAGE_BPS / 100}%</dt>
          <dd className="text-right">at least {usdc(q.minOut)}</dd>
        </dl>
      )}
      <div className="flex gap-2">
        {buying ? (
          <>
            {BUY_PRESETS.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={t.amount === a}
                onClick={() => t.setAmount(a)}
                className={chip}
              >
                {a}
              </button>
            ))}
            <button
              type="button"
              disabled={!t.balance}
              onClick={() => t.balance && t.setAmount(t.balance)}
              className={chip}
            >
              Max
            </button>
          </>
        ) : (
          SELL_PRESETS.map((pct) => {
            const a = percentOf(t.held?.shares, pct)
            return (
              <button
                key={pct}
                type="button"
                disabled={a === null}
                aria-pressed={a !== null && t.amount === a}
                onClick={() => a && t.setAmount(a)}
                className={chip}
              >
                {pct}%
              </button>
            )
          })
        )}
      </div>
      <label className="flex min-h-11 items-center gap-2 rounded-card border border-line px-3">
        <input
          inputMode="decimal"
          value={t.amount}
          onChange={(e) => t.setAmount(e.target.value)}
          aria-label={buying ? 'mUSDC to spend' : 'Shares to sell'}
          className="w-full bg-transparent py-2 font-mono text-19 tabular-nums outline-none"
        />
        <span className="text-13 text-ash-400">{buying ? 'mUSDC' : 'shares'}</span>
      </label>
      {buying && <p className="text-11 text-ash-400">Each share pays 1 mUSDC if {t.team} wins.</p>}
      {!t.check.ok && t.check.reason && (
        <p className="text-13 text-amber-400">
          {t.check.reason}
          {t.check.fund && t.ready === 'ready' && (
            <>
              {' '}
              <button
                type="button"
                disabled={p.funding}
                onClick={p.onFaucet}
                className="font-semibold underline disabled:opacity-50"
              >
                {p.funding ? 'Requesting…' : 'Get test mUSDC'}
              </button>
            </>
          )}
        </p>
      )}
      {p.fundNote && !t.fundNoteHidden && <p className="text-13 text-lume-300">{p.fundNote}</p>}
      <HoldButton
        label={label}
        tone={t.side === 'home' ? 'lume' : 'brass'}
        disabled={wait > 0 || sendDisabled(t.ready, t.check.ok, t.stage)}
        pending={t.stage !== null}
        onConfirm={t.send}
      />
      {effect === 'requote' && (
        <button
          type="button"
          onClick={t.quote.refresh}
          className="min-h-11 w-full rounded-card border border-amber-400/50 text-13 text-amber-400"
        >
          Get a new quote
        </button>
      )}
      {t.done && (
        <p className="text-13 text-lume-300">
          {t.done.text}{' '}
          <a
            href={explorerTx(t.done.signature)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View transaction
          </a>
        </p>
      )}
      <ErrorText error={t.shownError} />
    </div>
  )
}
