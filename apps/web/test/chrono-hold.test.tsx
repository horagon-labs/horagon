import { HoragonError } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HoldButton } from '../components/chrono/hold-button'
import { Pusher } from '../components/chrono/pusher'
import { errorEffect } from '../lib/chrono/errors'
import { type HoldInput, type HoldResult, hold, IDLE } from '../lib/chrono/hold'
import { type PusherInput, type PusherMode, pusherMode } from '../lib/chrono/pusher'

/** Runs inputs from IDLE and returns every result. */
function run(...inputs: [HoldInput['kind'], number][]): HoldResult[] {
  let state = IDLE
  return inputs.map(([kind, at]) => {
    const r = hold(state, { kind, at })
    state = r.state
    return r
  })
}

describe('hold (spec 3.2)', () => {
  it('confirms once the pointer has been down for 500 ms, and swallows the click after', () => {
    const [, held, up, click, next] = run(
      ['down', 0],
      ['held', 500],
      ['up', 620],
      ['press', 621],
      ['press', 900],
    )
    expect(held?.confirm).toBe(true)
    expect(up?.confirm).toBe(false)
    expect(click).toMatchObject({ confirm: false, armed: false })
    expect(next).toMatchObject({ confirm: false, armed: true })
  })

  it('confirms a release after 500 ms when the timer was late', () => {
    expect(run(['down', 0], ['up', 510])[1]?.confirm).toBe(true)
  })

  it('takes a short press as a first activation and a second within 1.5 s as the confirm', () => {
    const r = run(
      ['down', 0],
      ['up', 120],
      ['press', 121],
      ['down', 900],
      ['up', 980],
      ['press', 981],
    )
    expect(r[2]).toMatchObject({ confirm: false, armed: true })
    expect(r[5]?.confirm).toBe(true)
  })

  it('arms again when the second press comes after 1.5 s', () => {
    const [first, late] = run(['press', 0], ['press', 1_501])
    expect(first?.armed).toBe(true)
    expect(late).toMatchObject({ confirm: false, armed: true })
  })

  it('swallows the click that follows a touch release, whose pointerleave comes first', () => {
    const r = run(
      ['down', 0],
      ['held', 500],
      ['up', 900],
      ['leave', 901],
      ['press', 905],
      ['press', 1_200],
    )
    expect(r[4]).toMatchObject({ confirm: false, armed: false })
    expect(r[5]).toMatchObject({ confirm: false, armed: true })
  })

  it('does not keep swallowing when no click follows the release', () => {
    const r = run(['down', 0], ['held', 500], ['leave', 600], ['press', 3_000])
    expect(r[3]).toMatchObject({ confirm: false, armed: true })
  })

  it('swallows the click after a long hold released seconds after the confirm', () => {
    const r = run(['down', 0], ['held', 500], ['up', 2_500], ['press', 2_510])
    expect(r[3]).toMatchObject({ confirm: false, armed: false })
  })

  it('drops a hold when the pointer leaves', () => {
    const r = run(['down', 0], ['leave', 200], ['held', 500])
    expect(r.map((x) => x.confirm)).toEqual([false, false, false])
  })
})

describe('HoldButton (spec 3.2)', () => {
  const button = (over: Partial<Parameters<typeof HoldButton>[0]> = {}) =>
    renderToStaticMarkup(<HoldButton label="Buy CLE" onConfirm={() => {}} {...over} />)

  it('is a hold-safe button with an empty live region until armed', () => {
    const html = button()
    expect(html).toContain('hold-safe')
    expect(html).toContain('Buy CLE')
    expect(html).toContain('<span aria-live="polite" class="sr-only"></span>')
    expect(html).toContain('keep-motion')
  })

  it('spins and stays off while a send is in flight', () => {
    const html = button({ pending: true })
    expect(html).toContain('disabled=""')
    expect(html).toContain('animate-spin')
  })
})

describe('pusherMode (spec 3.2, 4.3, 6.1)', () => {
  const base: PusherInput = {
    state: 'live',
    ready: 'ready',
    balance: '493.74',
    effect: null,
    failedAction: 'buy',
    secsLeft: 3_730,
  }
  const mode = (over: Partial<PusherInput>) => pusherMode({ ...base, ...over })

  it('shows the two buy buttons while trading, with the close countdown near the end', () => {
    expect(mode({})).toEqual({ kind: 'buy', locked: false, note: null })
    expect(mode({ state: 'closing', secsLeft: 252 })).toEqual({
      kind: 'buy',
      locked: false,
      note: 'closes in 4:12',
    })
    expect(mode({ state: 'halted' })).toEqual({ kind: 'buy', locked: true, note: null })
  })

  it('turns into the faucet for no wallet, an empty wallet or a buy without the funds', () => {
    expect(mode({ ready: 'no-wallet', balance: undefined })).toEqual({ kind: 'faucet' })
    expect(mode({ balance: '0' })).toEqual({ kind: 'faucet' })
    const poor = errorEffect(new HoragonError('INSUFFICIENT_FUNDS', 'poor'))
    expect(mode({ effect: poor, failedAction: 'buy' })).toEqual({ kind: 'faucet' })
    expect(mode({ ready: 'loading', balance: undefined }).kind).toBe('buy')
  })

  it('keeps the buy buttons when a sell fails for funds, and once the error is cleared (I3)', () => {
    const poor = errorEffect(new HoragonError('INSUFFICIENT_FUNDS', 'poor'))
    expect(mode({ effect: poor, failedAction: 'sell' })).toEqual(mode({}))
    expect(mode({ effect: null, failedAction: 'buy' })).toEqual({
      kind: 'buy',
      locked: false,
      note: null,
    })
  })

  it('reads an unknown balance (RPC down) as not known, not as an empty wallet (M1)', () => {
    expect(mode({ balance: null })).toEqual({ kind: 'buy', locked: false, note: null })
  })

  it('says one line once trading is over, and nothing once there is a result', () => {
    expect(mode({ state: 'closed' })).toEqual({
      kind: 'line',
      text: 'Trading closed, waiting for the result',
    })
    expect(mode({ state: 'pre', secsLeft: null })).toEqual({
      kind: 'line',
      text: 'market opens 60 min before tip-off',
    })
    for (const state of ['resolved', 'challenged', 'proposed', 'void'] as const) {
      expect(mode({ state })).toEqual({ kind: 'none' })
    }
  })
})

describe('Pusher (spec 3.2)', () => {
  const pusher = (mode: PusherMode, over: Partial<Parameters<typeof Pusher>[0]> = {}) =>
    renderToStaticMarkup(
      <Pusher
        mode={mode}
        home="CLE"
        away="MEM"
        price={0.77}
        onPick={() => {}}
        funding={false}
        onFaucet={() => {}}
        {...over}
      />,
    )

  it('names each side with its price', () => {
    const html = pusher({ kind: 'buy', locked: false, note: null })
    expect(html).toContain('>Buy CLE 77¢</button>')
    expect(html).toContain('>Buy MEM 23¢</button>')
    expect(html).not.toContain('aria-pressed="')
  })

  it('locks both buttons when halted and marks the picked side on desktop', () => {
    expect(pusher({ kind: 'buy', locked: true, note: null }).match(/disabled=""/g)).toHaveLength(2)
    const desk = pusher({ kind: 'buy', locked: false, note: null }, { selected: 'away' })
    expect(desk).toContain('aria-pressed="false"')
    expect(desk).toContain('aria-pressed="true"')
  })

  it('offers the faucet and the lines', () => {
    expect(pusher({ kind: 'faucet' })).toContain('Get test mUSDC')
    expect(pusher({ kind: 'faucet' }, { funding: true })).toContain('Requesting…')
    expect(pusher({ kind: 'line', text: 'Trading closed, waiting for the result' })).toContain(
      'Trading closed, waiting for the result',
    )
    expect(pusher({ kind: 'none' })).toBe('')
  })
})
