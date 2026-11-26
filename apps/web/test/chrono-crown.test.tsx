import { HoragonError, PLAY_MONEY_NOTICE } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Bezel } from '../components/chrono/bezel'
import { CrownPanel, type CrownPanelProps } from '../components/chrono/crown-panel'
import { backdropHit, CrownSheet } from '../components/chrono/crown-sheet'
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
    errorQuoteNow: NOW,
    failedAction: 'buy',
    shownError: undefined,
    fundNoteHidden: false,
    loaded: true,
    ageNeeded: false,
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
    expect(html).toContain('aria-label="CLE to win, 77%, after this trade 79%"')
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
    // One number only: the error line leaves the seconds to the live countdown (M6).
    expect(html).toContain('Too many requests.')
    expect(html).not.toContain('Try again in 5 s')
  })

  it('stops the shake and the new-quote button once a newer quote has come (M6, N1)', () => {
    const error = new HoragonError('SLIPPAGE_EXCEEDED', 'price moved')
    const newer = { data: quote({ now: NOW + 3 }), error: undefined, failures: 0, refresh: noop }
    // The browser's clock is an hour ahead: errorAt is far past every quote's now.
    const ahead = { error, shownError: error, errorAt: NOW + 3_600, errorQuoteNow: NOW }
    expect(panel({ ...ahead, quote: newer })).not.toContain('animate-shake')
    expect(panel({ ...ahead, quote: newer })).not.toContain('Get a new quote')
    // An hour behind: the quote from before the error must not pass for a newer one.
    const behind = { error, shownError: error, errorAt: NOW - 3_600, errorQuoteNow: NOW }
    expect(panel(behind)).toContain('animate-shake')
    expect(panel(behind)).toContain('Get a new quote')
  })

  it('offers no new quote on a market that has stopped quoting (N3)', () => {
    const error = new HoragonError('SLIPPAGE_EXCEEDED', 'price moved')
    const closed = { ok: false, quote: false, reason: 'Trading has closed.' }
    const html = panel({ error, shownError: error, check: closed }, { state: 'closed' })
    expect(html).not.toContain('Get a new quote')
    expect(html).not.toContain('animate-shake')
  })

  it('shows the stale line on the crown’s own dial, and Reconnecting in the sheet only (M4, N5)', () => {
    expect(panel()).not.toContain('Reconnecting…')
    const inline = panel({}, { stale: true })
    expect(inline).toContain('data-stale')
    expect(inline).not.toContain('Reconnecting…')
    const sheet = panel({}, { stale: true, staleLine: true })
    expect(sheet).toContain('data-stale')
    expect(sheet).toContain('Reconnecting…')
  })

  it('sets up a wallet with a plain button, not a hold (M12)', () => {
    const html = panel({ ready: 'no-wallet', balance: undefined })
    expect(html).toMatch(
      /<button type="button" class="min-h-11[^"]*">Get 1,000 play mUSDC to start<\/button>/,
    )
    expect(html).not.toContain('hold-safe')
  })

  it('asks 18+ inline above the set-up button, which stays off until the tick (R5)', () => {
    const html = panel({ ready: 'no-wallet', balance: undefined, ageNeeded: true })
    const box = html.indexOf('I am 18 or older')
    const button = html.indexOf('Get 1,000 play mUSDC to start')
    expect(html).toContain('Horagon is play money on Solana devnet. No real value. No prizes.')
    expect(box).toBeGreaterThan(0)
    expect(button).toBeGreaterThan(box)
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Get 1,000 play mUSDC to start/)
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*>/)
  })

  it('asks 18+ inline for a stored burner never asked, and holds the Buy until the tick', () => {
    const html = panel({ ageNeeded: true })
    expect(html).toContain('I am 18 or older')
    expect(html).toMatch(/<button type="button" disabled=""[^>]*class="hold-safe/)
    expect(panel()).not.toContain('I am 18 or older')
    expect(panel()).not.toMatch(/<button type="button" disabled=""[^>]*class="hold-safe/)
  })

  it('says only "Loading your balance…" until the wallet storage opens (R5 review finding 1)', () => {
    // The server render and the first browser render: no wallet and no 18+ answer known yet.
    const html = panel({ loaded: false, ready: 'no-wallet', balance: undefined, ageNeeded: true })
    expect(html).toContain('data-wallet-wait="true">Loading your balance…</p>')
    expect(html).not.toContain('I am 18 or older')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('Get 1,000 play mUSDC')
    expect(html).not.toContain('hold-safe')
    // Once it opened, the same visitor sees the ask, or straight away the Buy.
    expect(panel({ ready: 'no-wallet', balance: undefined, ageNeeded: true })).toContain(
      'I am 18 or older',
    )
    expect(panel()).not.toContain('Loading your balance…')
    expect(panel()).toContain('hold-safe')
  })

  it('turns Max off for a balance of zero as well as an unknown one (M15)', () => {
    expect(panel({ balance: '0' })).toMatch(/disabled=""[^>]*>Max<\/button>/)
    expect(panel({ balance: undefined })).toMatch(/disabled=""[^>]*>Max<\/button>/)
    expect(panel()).not.toMatch(/disabled=""[^>]*>Max<\/button>/)
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

  it('lets the old result go once the market moves on to its result (N2)', () => {
    const error = new HoragonError('MARKET_CLOSED', 'closed')
    for (const state of ['proposed', 'challenged', 'resolved', 'void'] as const) {
      expect(crownShown(state, { ...idle, done }), state).toBe(false)
      expect(crownShown(state, { ...idle, error }), state).toBe(false)
    }
    // A send still in flight keeps it, whatever the state.
    expect(crownShown('resolved', { ...idle, stage: 'confirming' })).toBe(true)
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

  it('keeps the play-money line on screen, since the sheet covers the banner (I5)', () => {
    const html = renderToStaticMarkup(
      <CrownSheet open={false} onClose={noop} title="Buy CLE">
        <p>inside</p>
      </CrownSheet>,
    )
    expect(PLAY_MONEY_NOTICE).toBe('Play-money on devnet. No real value. No prizes.')
    expect(html).toContain(PLAY_MONEY_NOTICE)
    expect(html.indexOf(PLAY_MONEY_NOTICE)).toBeGreaterThan(html.indexOf('<p>inside</p>'))
  })

  it('keeps its title and Close at the top while the content scrolls', () => {
    const html = renderToStaticMarkup(
      <CrownSheet open={false} onClose={noop} title="Buy CLE">
        <p>inside</p>
      </CrownSheet>,
    )
    // The header row sits in the scrolling area, sticky and opaque, before the content.
    expect(html).toMatch(/<div class="[^"]*\bsticky top-0\b[^"]*\bbg-enamel-900\b[^"]*"><h2/)
    expect(html.indexOf('aria-label="Close"')).toBeLessThan(html.indexOf('<p>inside</p>'))
  })
})

describe('backdropHit (CrownSheet)', () => {
  const sheet = {}
  const box = { left: 0, top: 300, right: 390, bottom: 844 }

  it('is a press on the dialog itself, outside the panel', () => {
    expect(backdropHit(sheet, sheet, { x: 200, y: 120 }, box)).toBe(true)
  })

  it('is not a press inside the panel, nor one on any element in it', () => {
    expect(backdropHit(sheet, sheet, { x: 200, y: 600 }, box)).toBe(false)
    expect(backdropHit({}, sheet, { x: 200, y: 120 }, box)).toBe(false)
    expect(backdropHit({}, sheet, { x: 200, y: 600 }, box)).toBe(false)
  })
})
