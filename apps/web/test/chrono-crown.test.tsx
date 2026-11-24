import { HoragonError } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Bezel } from '../components/chrono/bezel'
import { CrownPanel, type CrownPanelProps } from '../components/chrono/crown-panel'
import { CrownSheet } from '../components/chrono/crown-sheet'
import { buySteps, onRing, sellSteps, startsDrag } from '../lib/chrono/bezel'
import { detail, market, NOW, position, quote } from '../lib/chrono/fixtures'
import { crownShown } from '../lib/chrono/game'
import type { Trade } from '../lib/use-trade'

const noop = () => {}

/** A Trade as useTrade returns it: a ready wallet with 37.5 mUSDC buying 25 of CLE. */
function trade(over: Partial<Trade> = {}): Trade {
  return {
    side: 'home',
    action: 'buy',
    setDirection: noop,
    amount: '25',
    setAmount: noop,
    team: 'CLE',
    ready: 'ready',
    held: undefined,
    balance: '37.5',
    check: { ok: true, quote: true },
    quote: { data: quote(), error: undefined, failures: 0, refresh: noop },
    lastQuote: undefined,
    quotePending: false,
    stage: null,
    done: null,
    error: undefined,
    errorAt: NOW,
    failedAction: 'buy',
    shownError: undefined,
    fundNoteHidden: false,
    send: noop,
    ...over,
  }
}

const panel = (over: Partial<Trade> = {}, props: Partial<CrownPanelProps> = {}) =>
  renderToStaticMarkup(
    <CrownPanel
      trade={trade(over)}
      game={detail()}
      market={market()}
      state="live"
      timeLeft={0.33}
      now={NOW}
      funding={false}
      fundNote={undefined}
      onFaucet={noop}
      {...props}
    />,
  )

const bezel = (steps: ReturnType<typeof buySteps>, index: number) =>
  renderToStaticMarkup(
    <Bezel steps={steps} index={index} onChange={noop} label="mUSDC to spend">
      <span />
    </Bezel>,
  )

describe('Bezel (spec 2.6, 3.2)', () => {
  it('is a slider whose last step is the balance', () => {
    const html = bezel(buySteps('37.5'), 4)
    expect(html).toContain('role="slider"')
    expect(html).toContain('aria-valuemin="1"')
    expect(html).toContain('aria-valuemax="37.5"')
    expect(html).toContain('aria-valuenow="25"')
    expect(html).toContain('aria-valuetext="25 mUSDC"')
    expect(html).toContain('data-crown')
  })

  it('has one step for a balance under the smallest step (Review Focus 2)', () => {
    const html = bezel(buySteps('0.5'), 0)
    expect(html).toContain('aria-valuemin="0.5"')
    expect(html).toContain('aria-valuemax="0.5"')
    expect(html).toContain('aria-valuenow="0.5"')
  })

  it('says so when there is nothing to choose', () => {
    const html = bezel([], 0)
    expect(html).toContain('aria-valuetext="No amount"')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('data-bezel-arc')
  })

  it('reads a sell step as a share of the position', () => {
    expect(bezel(sellSteps('14.1'), 2)).toContain('aria-valuetext="50% · 7.05 shares"')
  })
})

describe('Bezel input decisions', () => {
  it('starts a drag only for the primary button, a finger or a pen', () => {
    expect(startsDrag(0, 'mouse')).toBe(true)
    expect(startsDrag(-1, 'touch')).toBe(true)
    expect(startsDrag(-1, 'pen')).toBe(true)
    expect(startsDrag(2, 'mouse')).toBe(false)
    expect(startsDrag(1, 'mouse')).toBe(false)
  })

  it('takes the pointer on the ring only, not near the centre (spec 2.6)', () => {
    expect(onRing(0, 0, 100)).toBe(false)
    expect(onRing(30, 40, 100)).toBe(false)
    expect(onRing(62, 0, 100)).toBe(true)
    expect(onRing(-60, -60, 100)).toBe(true)
  })
})

describe('CrownPanel (spec 3.2, 5.5)', () => {
  it('keeps the dial beside the slider, so screen readers reach its label (spec 2.6)', () => {
    const html = panel()
    const start = html.indexOf('role="slider"')
    const end = html.indexOf('</div>', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(html.slice(start, end)).not.toContain('role="img"')
    expect(html.slice(end)).toContain('role="img"')
  })

  it('points the ghost needle at the quote’s price after the trade', () => {
    const html = panel()
    expect(html).toMatch(/<g transform="rotate\(78.3 100 100\)"[^>]*data-needle="ghost"/)
    expect(html).toContain('data-impact')
    expect(html).toContain('aria-label="CLE wins, 77 cents, after this trade 79 cents"')
  })

  it('shows the numbers, the presets and the hold button', () => {
    const html = panel()
    for (const words of ['Shares received', 'Average price', 'If CLE wins', 'Price impact']) {
      expect(html).toContain(words)
    }
    expect(html).toContain('31.50')
    expect(html).toContain('1.20%')
    expect(html).toContain('>Buy CLE</button>')
    expect(html).toContain('hold-safe')
    expect(html).toContain('aria-valuenow="25"')
  })

  it('dims the ghost while the next quote loads', () => {
    expect(panel({ quotePending: true })).toContain('opacity-30')
  })

  it('sells a share of the position with percentage presets', () => {
    const held = position()
    const html = panel({ action: 'sell', held, amount: '7.05' })
    expect(html).toContain('aria-label="Shares to sell"')
    expect(html).toContain('aria-valuetext="50% · 7.05 shares"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>50%<\/button>/)
    expect(html).not.toContain('If CLE wins')
  })

  it('cannot switch to Sell without shares', () => {
    expect(panel()).toMatch(/aria-pressed="false" disabled=""[^>]*>Sell CLE<\/button>/)
  })

  it('turns Sell off and unpressed once a full sell leaves nothing held (M11)', () => {
    const html = panel({ action: 'sell', held: undefined, amount: '' })
    expect(html).toMatch(/aria-pressed="false" disabled=""[^>]*>Sell CLE<\/button>/)
  })

  it('shakes the ghost and offers a new quote after SLIPPAGE_EXCEEDED (spec 6.1)', () => {
    const error = new HoragonError('SLIPPAGE_EXCEEDED', 'price moved')
    const html = panel({ error, shownError: error })
    expect(html).toContain('animate-shake')
    expect(html).toContain('Get a new quote')
  })

  it('counts down a RATE_LIMITED send before it can go again (spec 6.1)', () => {
    const error = new HoragonError('RATE_LIMITED', 'slow down', { retryAfterSecs: 4.2 })
    const html = panel({ error, shownError: error, errorAt: NOW }, { now: NOW + 1 })
    expect(html).toContain('Try again in 4 s')
    expect(html).toMatch(/<button type="button" disabled=""/)
  })
})

describe('crownShown (I4)', () => {
  const idle = { stage: null, done: null, error: undefined }
  const done = { signature: '5'.repeat(88), text: 'Bought about 31.50 CLE shares.' }

  it('shows the crown while the market trades', () => {
    expect(crownShown('live', idle)).toBe(true)
    expect(crownShown('closed', idle)).toBe(false)
    expect(crownShown('halted', idle)).toBe(false)
  })

  it('keeps the crown on a closed market while a send or its result is on screen', () => {
    expect(crownShown('closed', { ...idle, done })).toBe(true)
    expect(crownShown('closed', { ...idle, stage: 'confirming' })).toBe(true)
    const error = new HoragonError('MARKET_CLOSED', 'closed')
    expect(crownShown('halted', { ...idle, error })).toBe(true)
  })
})

describe('CrownSheet (spec 3.2)', () => {
  it('is a native dialog named for the trade, with a close button', () => {
    const html = renderToStaticMarkup(
      <CrownSheet open={false} onClose={noop} title="Buy CLE">
        <p>inside</p>
      </CrownSheet>,
    )
    expect(html).toContain('<dialog aria-label="Buy CLE"')
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('<p>inside</p>')
  })
})
