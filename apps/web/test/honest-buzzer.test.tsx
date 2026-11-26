// R5c: the buzzer reads true everywhere. Between the keeper's first Final read and its halt
// reaching the index, the API serves a final game with its market still open and end_ts ahead;
// the keeper's halt at the buzzer is the normal close, never an emergency; a dial that stopped
// trading shows no time left; and a game that started without a market says so.
import { HoragonError, type Resolution } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CrownPanel } from '../components/chrono/crown-panel'
import { stateLine } from '../components/chrono/dial-look'
import { MiniDial } from '../components/chrono/mini-dial'
import { ResolutionCard } from '../components/chrono/resolution-card'
import { errorText } from '../components/error-text'
import { boardItem, itemLabel, rowWords } from '../lib/chrono/board'
import { dialCaption, haltLinkLabel, positionStatus } from '../lib/chrono/copy'
import { detail, game, market, NOW, quote } from '../lib/chrono/fixtures'
import { canTrade, gameDial } from '../lib/chrono/game'
import type { DialState } from '../lib/chrono/state'
import { BUZZER_CLOSED, checkTrade, type TradeFormInput } from '../lib/trade-form'
import { sendDisabled } from '../lib/trade-view'
import type { Trade } from '../lib/use-trade'

// CLE (home) lost 104-110 to MEM.
const over = {
  status: 'final' as const,
  homeScore: 104,
  awayScore: 110,
  period: 4,
  clockSecs: null,
}
const open = market({ status: 'open' })
const halted = market({ status: 'halted' })
const atBuzzer = game({ ...over, markets: [open] })
const noop = () => {}

const buyInput = (over: Partial<TradeFormInput> = {}): TradeFormInput => ({
  action: 'buy',
  amount: '10',
  balance: '37.5',
  shares: undefined,
  marketStatus: 'open',
  endTs: open.endTs,
  nowSecs: NOW,
  ...over,
})

/** The crown as MarketBlock draws it, with a ready wallet buying 10 of CLE. */
function crown(t: Partial<Trade>, state: DialState, g = detail({ ...over, markets: [open] })) {
  const trade: Trade = {
    side: 'home',
    action: 'buy',
    setDirection: noop,
    amount: '10',
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
    ...t,
  }
  return renderToStaticMarkup(
    <CrownPanel
      trade={trade}
      game={g}
      market={open}
      state={state}
      timeLeft={0}
      now={NOW}
      funding={false}
      fundNote={undefined}
      onFaucet={noop}
    />,
  )
}

describe('final means closed (item 1)', () => {
  it('closes an open market under a final game, on the board and the game screen', () => {
    const item = boardItem(atBuzzer, undefined, NOW)
    expect(item.secsLeft).toBeGreaterThan(0)
    expect(item.state).toBe('closed')
    expect(rowWords(item)).toEqual({ subject: 'CLE lost', value: '77%', note: 'result pending' })
    const d = gameDial(detail({ ...over, markets: [open] }), open, null, null, NOW)
    expect(d.state).toBe('closed')
    expect(canTrade(d.state)).toBe(false)
    expect(d.label).toBe('Final, CLE lost, result pending, 77%, model 74%, trading closed')
    expect(d.label).not.toMatch(/open until/)
    expect(stateLine(d.state, atBuzzer, d.secsLeft, NOW)).toBe('Trading closed · result pending')
  })

  it('refuses the trade with the buzzer line, so Buy is off', () => {
    const check = checkTrade(buyInput({ gameStatus: 'final' }))
    expect(check).toEqual({ ok: false, quote: false, reason: BUZZER_CLOSED })
    expect(BUZZER_CLOSED).toBe('Trading closed at the final buzzer.')
    expect(sendDisabled('ready', check.ok, null)).toBe(true)
    expect(checkTrade(buyInput({ gameStatus: 'final', marketStatus: 'halted' })).reason).toBe(
      BUZZER_CLOSED,
    )
    expect(checkTrade(buyInput({ gameStatus: 'final', action: 'sell', shares: '5' })).ok).toBe(
      false,
    )
    // The same market while the game is on the court trades.
    expect(checkTrade(buyInput({ gameStatus: 'live' })).ok).toBe(true)
  })

  it('draws Buy disabled under the buzzer line when a send kept the crown on screen', () => {
    const html = crown({ check: checkTrade(buyInput({ gameStatus: 'final' })) }, 'closed')
    expect(html).toMatch(/<button type="button" disabled=""[^>]*class="hold-safe/)
    expect(html).toContain('Trading closed at the final buzzer.')
  })
})

describe('no "halted" for a normal close (item 2)', () => {
  const resolution: Resolution = {
    market: open.pubkey,
    kind: 'winner',
    status: 'halted',
    outcome: null,
    evidenceHash: null,
    evidenceUrl: null,
    createSig: null,
    haltSig: '5'.repeat(88),
    proposeSig: null,
    finalizeSig: null,
    recycleSig: null,
    externalLp: false,
  }

  it('reads a halted position as "trading closed" in the wallet sheet', () => {
    expect(positionStatus('halted')).toBe('trading closed')
    expect(positionStatus('open')).toBe('open')
    expect(positionStatus('finalized')).toBe('finalized')
  })

  it('labels the halt transaction "Closed" once the game is final, "Halted" before', () => {
    const final = renderToStaticMarkup(
      <ResolutionCard game={detail({ ...over, resolutions: [resolution] })} state="closed" />,
    )
    expect(final).toMatch(/>Closed<\/a>/)
    expect(final).not.toContain('Halted')
    const mid = renderToStaticMarkup(
      <ResolutionCard game={detail({ resolutions: [resolution] })} state="halted" />,
    )
    expect(mid).toMatch(/>Halted<\/a>/)
    expect(haltLinkLabel({ status: 'final' })).toBe('Closed')
    expect(haltLinkLabel({ status: 'live' })).toBe('Halted')
  })

  it('says the buzzer line for MARKET_HALTED in the crown once the game is final', () => {
    const halt = new HoragonError('MARKET_HALTED', 'Trading on this market is halted.', {
      hint: 'Wait for the result, then claim.',
    })
    expect(errorText(halt, { gameFinal: true })).toBe('Trading closed at the final buzzer.')
    expect(errorText(halt)).toBe(
      'Trading on this market is halted. Wait for the result, then claim.',
    )
    const html = crown({ error: halt, shownError: halt }, 'closed')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Trading closed at the final buzzer.')
    expect(html).not.toMatch(/halted/i)
    // A halt while the game is on the court keeps its own words.
    const live = crown({ error: halt, shownError: halt }, 'halted', detail({ markets: [halted] }))
    expect(live).toContain('Trading on this market is halted.')
  })
})

describe('no time left once trading stopped (item 3)', () => {
  it('is 0 after a close at the buzzer, with end_ts still ahead', () => {
    for (const m of [open, halted]) {
      const item = boardItem(game({ ...over, markets: [m] }), undefined, NOW)
      expect(item.secsLeft, m.status).toBeGreaterThan(0)
      expect(item.timeLeft, m.status).toBe(0)
      const d = gameDial(detail({ ...over, markets: [m] }), m, NOW - 600, null, NOW)
      expect(d.timeLeft, m.status).toBe(0)
    }
  })

  it('is 0 in every state after trading, and only then', () => {
    const at = (m: ReturnType<typeof market>, g: Parameters<typeof game>[0] = over) =>
      boardItem(game({ ...g, markets: [m] }), undefined, NOW)
    const stopped = {
      halted: at(halted, {}),
      proposed: at(market({ status: 'proposed' })),
      challenged: at(market({ status: 'challenged' })),
      resolved: at(market({ status: 'finalized', outcome: 'no' })),
      void: at(open, { status: 'postponed' }),
      closed: at(open),
    }
    for (const [state, item] of Object.entries(stopped)) {
      expect(item.state).toBe(state)
      expect(item.timeLeft, state).toBe(0)
    }
    expect(at(open, {}).timeLeft).toBeGreaterThan(0)
    expect(boardItem(game({ status: 'scheduled', markets: [] }), undefined, NOW).timeLeft).toBe(1)
  })

  it('draws no time ring arc for it', () => {
    const item = boardItem(atBuzzer, undefined, NOW)
    const mini = renderToStaticMarkup(
      <MiniDial price={item.price} timeLeft={item.timeLeft} state={item.state} held={false} />,
    )
    expect(mini).toMatch(/<path d=""[^>]*data-ring/)
  })
})

describe('a game that started with no market (item 6)', () => {
  const none = (status: 'live' | 'final') =>
    boardItem(game({ ...(status === 'final' ? over : {}), status, markets: [] }), undefined, NOW)

  it('says "No market for this game", never an opening time that has passed', () => {
    for (const status of ['live', 'final'] as const) {
      const item = none(status)
      expect(item.state).toBe('pre')
      expect(stateLine(item.state, item.game, item.secsLeft, NOW)).toBe('No market for this game')
      expect(rowWords(item).note).toBe('no market')
      expect(itemLabel(item)).toMatch(/no market for this game$/)
      expect(itemLabel(item)).not.toMatch(/opens/)
    }
  })

  it('has no "result pending" for a final game without a market', () => {
    const item = none('final')
    expect(dialCaption(item.state, item.game, null)).toBe('Final · CLE lost')
    expect(itemLabel(item)).toBe(
      'MEM 110, CLE 104. Final, CLE lost, no price yet, model 74%, no market for this game',
    )
  })

  it('still says when the market opens for a game not started yet', () => {
    const item = boardItem(game({ status: 'scheduled', markets: [] }), undefined, NOW)
    expect(stateLine(item.state, item.game, item.secsLeft, NOW)).toBe('Opens 60 min before tip-off')
    expect(rowWords(item).note).toMatch(/^opens /)
  })
})
