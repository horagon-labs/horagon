// R5c: the buzzer reads true everywhere. Between the keeper's first Final read and its halt
// reaching the index, the API serves a final game with its market still open and end_ts ahead;
// the keeper's halt at the buzzer is the normal close, never an emergency; a dial that stopped
// trading shows no time left; and a game that started without a market says so.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HoragonError, type Resolution } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CrownPanel, type CrownPanelProps } from '../components/chrono/crown-panel'
import { ringDash, ringShare, stateLine } from '../components/chrono/dial-look'
import { MiniDial } from '../components/chrono/mini-dial'
import { NightDial } from '../components/chrono/night-dial'
import { Pusher } from '../components/chrono/pusher'
import { ResolutionCard } from '../components/chrono/resolution-card'
import { errorText } from '../components/error-text'
import { type BoardItem, boardItem, itemLabel, listOrder, rowWords } from '../lib/chrono/board'
import { dialCaption, externalLpNote, haltLinkLabel, positionStatus } from '../lib/chrono/copy'
import { detail, game, market, NOW, quote } from '../lib/chrono/fixtures'
import { canTrade, gameDial } from '../lib/chrono/game'
import { type DialState, dialLabel, stillTrades } from '../lib/chrono/state'
import { packTracks } from '../lib/chrono/tracks'
import { BUZZER_CLOSED, checkTrade, type TradeFormInput } from '../lib/trade-form'
import { whenStillOk } from '../lib/trade-shared'
import { sendDisabled } from '../lib/trade-view'
import type { Trade } from '../lib/use-trade'
import { importErrorText, SOMETHING_WRONG, WALLET_PREPARING } from '../lib/wallet-copy'

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
function crown(
  t: Partial<Trade>,
  state: DialState,
  g = detail({ ...over, markets: [open] }),
  props: Partial<CrownPanelProps> = {},
) {
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
      {...props}
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
    // A halt while the game is on the court has no result to check (M6).
    expect(checkTrade(buyInput({ gameStatus: 'live', marketStatus: 'halted' })).reason).toBe(
      'Trading is halted.',
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
    gameMarket: 'GameMarket11111111111111111111111111111111',
    proposedAt: null,
    challengeEndsAt: null,
  }

  it('reads a halted position as "trading closed" in the wallet sheet', () => {
    expect(positionStatus('halted')).toBe('trading closed')
    // An open market says nothing: between the buzzer and the halt it is no longer open (refix).
    expect(positionStatus('open')).toBeNull()
    expect(positionStatus('finalized')).toBe('finalized')
  })

  it('labels the halt transaction "Closed" once the game is final, "Halted" before', () => {
    const final = renderToStaticMarkup(
      <ResolutionCard
        game={detail({ ...over, resolutions: [resolution] })}
        state="closed"
        now={NOW}
      />,
    )
    expect(final).toMatch(/>Closed<\/a>/)
    expect(final).not.toContain('Halted')
    const mid = renderToStaticMarkup(
      <ResolutionCard game={detail({ resolutions: [resolution] })} state="halted" now={NOW} />,
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
      <MiniDial price={item.price} timeLeft={item.timeLeft} state={item.state} />,
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

// Refix round 1: the review findings on R5c.
const source = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8')

describe('the first wallet action waits for its code, and checks again before it builds (refix)', () => {
  it('builds only if the trade is still allowed once the signer has loaded', async () => {
    // The game poll turns the game final while the signer loads, before the halt is indexed.
    let gameStatus: 'live' | 'final' = 'live'
    const stillOk = () => checkTrade(buyInput({ gameStatus })).ok
    const send = vi.fn(async () => 'sent')
    const load = async () => {
      gameStatus = 'final'
      return { executeTrade: send }
    }
    expect(stillOk()).toBe(true)
    await expect(whenStillOk(load, stillOk, (m) => m.executeTrade())).resolves.toBeNull()
    expect(send).not.toHaveBeenCalled()
    // Still live once loaded: the send goes.
    gameStatus = 'live'
    const live = async () => ({ executeTrade: send })
    await expect(whenStillOk(live, stillOk, (m) => m.executeTrade())).resolves.toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
    // A load that fails sends nothing, and the caller gets the error.
    const broken = () => Promise.reject(new Error('ChunkLoadError'))
    await expect(whenStillOk(broken, stillOk, send)).rejects.toThrow('ChunkLoadError')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('useTrade checks the latest render, not the hold, before and after the load', () => {
    const t = source('lib/use-trade.ts')
    const submit = t.slice(t.indexOf('async function submit'), t.indexOf('return {\n    side,'))
    expect(submit).toContain('latestCheck.current(action, amount, side).ok')
    expect(submit).toMatch(/whenStillOk\(\s*\(\) => import\('\.\/trade'\),\s*stillOk,/)
    expect(submit).not.toMatch(/!check\.ok/)
    // Pending from the hold: the stage is set before withAge, and cleared when no send started.
    const send = t.slice(t.indexOf('send: (affirmedHere)'))
    expect(send.indexOf("setStage('building')")).toBeGreaterThan(-1)
    expect(send.indexOf("setStage('building')")).toBeLessThan(send.indexOf('withAge('))
    expect(send).toContain('if (!busy.current) setStage(null)')
  })

  it('shows the crown pending while the key code loads, and its buttons waiting', () => {
    const pending = crown({ stage: 'building', check: { ok: true, quote: true } }, 'live', detail())
    expect(pending).toContain('Preparing…')
    expect(pending).toMatch(/<button type="button" disabled=""[^>]*class="hold-safe/)
    // No wallet yet: the set-up button says it is preparing, and waits.
    const none = crown({ ready: 'no-wallet' }, 'live', detail(), { preparing: true })
    expect(none).toMatch(/<button type="button" disabled=""[^>]*>Preparing…<\/button>/)
    // The faucet beside "Not enough mUSDC" waits too.
    const poor = crown(
      { check: { ok: false, quote: true, reason: 'Not enough mUSDC.', fund: true } },
      'live',
      detail(),
      { preparing: true },
    )
    expect(poor).toMatch(/disabled=""[^>]*>Preparing…<\/button>/)
    const pusher = renderToStaticMarkup(
      <Pusher
        mode={{ kind: 'faucet' }}
        home="CLE"
        away="MEM"
        price={0.77}
        onPick={noop}
        funding={false}
        preparing
        onFaucet={noop}
      />,
    )
    expect(pusher).toMatch(/disabled=""[^>]*>Preparing…<\/button>/)
    expect(WALLET_PREPARING).toBe('Preparing…')
  })

  it('"Set up wallet" shows its own failure, never the faucet’s line', () => {
    const wallet = source('components/wallet.tsx')
    expect(wallet).toContain('openGate: core.ask,')
    expect(wallet).not.toMatch(/ask\(\)\.catch/)
    const button = source('components/wallet-button.tsx')
    expect(button).toContain('openGate().catch(() => setFailed(true))')
    expect(button).toContain('{SOMETHING_WRONG}')
    expect(button).toContain('disabled={preparing}')
  })

  it('calls a key bad only for the key’s own problem', () => {
    expect(importErrorText(new Error('A secret key is 64 bytes; this one is 3.'))).toBe(
      'A secret key is 64 bytes; this one is 3.',
    )
    const chunk = Object.assign(new Error('Loading chunk 2brefhixm84dm failed.'), {
      name: 'ChunkLoadError',
    })
    expect(importErrorText(chunk)).toBe(SOMETHING_WRONG)
    expect(importErrorText(new TypeError('Failed to fetch dynamically imported module'))).toBe(
      SOMETHING_WRONG,
    )
    expect(importErrorText('nope')).toBe(SOMETHING_WRONG)
    expect(SOMETHING_WRONG).toBe('Something went wrong. Try again.')
    // The Export / Import block moved to key-backup.tsx (R7), the same code.
    expect(source('components/key-backup.tsx')).toContain('setImportError(importErrorText(err))')
  })
})

describe('a game that started with no market does not trade (refix)', () => {
  const noMarket = (status: 'live' | 'final', id = 'nba-1') =>
    boardItem(
      game({ ...(status === 'final' ? over : {}), id, status, markets: [] }),
      undefined,
      NOW,
    )

  it('has no time left, on the board and the game screen', () => {
    for (const status of ['live', 'final'] as const) {
      const item = noMarket(status)
      expect(item.state).toBe('pre')
      expect(item.trading, status).toBe(false)
      expect(item.timeLeft, status).toBe(0)
      const g = detail({ ...(status === 'final' ? over : {}), status, markets: [] })
      expect(gameDial(g, undefined, null, null, NOW).timeLeft, status).toBe(0)
    }
    // A game not started yet keeps its full ring: its market still opens.
    const later = boardItem(game({ status: 'scheduled', markets: [] }), undefined, NOW)
    expect(later.trading).toBe(true)
    expect(later.timeLeft).toBe(1)
    expect(stillTrades('pre', { status: 'scheduled' }, false)).toBe(true)
    expect(stillTrades('pre', { status: 'live' }, false)).toBe(false)
    expect(stillTrades('live', { status: 'live' }, true)).toBe(true)
    expect(stillTrades('closed', { status: 'final' }, true)).toBe(false)
  })

  it('sorts after the live and the coming games, and its Night dial arc is ash, up to now', () => {
    const live = boardItem(game({ id: 'nba-live' }), undefined, NOW)
    const soon = boardItem(
      game({ id: 'nba-soon', status: 'scheduled', scheduledTipoff: '2026-11-25T03:30:00Z' }),
      undefined,
      NOW,
    )
    const none = noMarket('live', 'nba-none')
    expect([none, soon, live].sort(listOrder).map((i) => i.id)).toEqual([
      'nba-live',
      'nba-soon',
      'nba-none',
    ])
    const html = renderToStaticMarkup(
      <NightDial items={[live, none]} now={NOW} selectedId={null} onSelect={noop} emptyText="" />,
    )
    const arcs = (id: string) =>
      [...html.matchAll(/<g><path [^>]*class="([^"]*)"[^>]*><\/path><path [^>]*data-id="([^"]+)"/g)]
        .filter((m) => m[2] === id)
        .map((m) => m[1] ?? '')
    expect(arcs('nba-none').length).toBeGreaterThan(0)
    for (const c of arcs('nba-none')) expect(c).toMatch(/stroke-ash-400/)
    expect(arcs('nba-live').some((c) => /stroke-live/.test(c))).toBe(true)
    const track = packTracks([live, none], NOW).tracks.find((t) => t.item.id === 'nba-none')
    expect(track?.to).toBe(NOW)
  })
})

describe('the Night dial draws no time ahead for a stopped game (refix)', () => {
  it('ends a stopped arc at now, keeps a trading one to its end, and a void one ahead', () => {
    const closed = boardItem(game({ ...over, id: 'nba-closed', markets: [open] }), undefined, NOW)
    const live = boardItem(game({ id: 'nba-live' }), undefined, NOW)
    const ahead: BoardItem = boardItem(
      game({
        id: 'nba-void',
        status: 'postponed',
        scheduledTipoff: '2026-11-25T05:00:00Z',
        markets: [],
      }),
      undefined,
      NOW,
    )
    const tracks = packTracks([closed, live, ahead], NOW).tracks
    const to = (id: string) => tracks.find((t) => t.item.id === id)?.to
    expect(closed.state).toBe('closed')
    expect(to('nba-closed')).toBe(NOW)
    expect(to('nba-live')).toBe(open.endTs)
    expect(ahead.state).toBe('void')
    expect(to('nba-void')).toBe(ahead.interval.end)
  })
})

describe('a halt mid-game keeps its amber hatched ring (refix)', () => {
  it('draws the full ring, dashed, with no time left', () => {
    const item = boardItem(game({ markets: [halted] }), undefined, NOW)
    expect(item.state).toBe('halted')
    expect(item.timeLeft).toBe(0)
    expect(ringShare('halted', 0)).toBe(1)
    expect(ringDash('halted')).toBe('3 3')
    expect(ringShare('closed', 0)).toBe(0)
    expect(ringDash('closed')).toBeUndefined()
    const mini = renderToStaticMarkup(
      <MiniDial price={item.price} timeLeft={item.timeLeft} state={item.state} />,
    )
    expect(mini).toMatch(
      /<path d="M [^"]+" [^>]*stroke-dasharray="3 3" class="stroke-amber-400" data-ring/,
    )
    // At the final buzzer the same halt is the close: no ring.
    const closed = boardItem(game({ ...over, markets: [halted] }), undefined, NOW)
    const shut = renderToStaticMarkup(
      <MiniDial price={closed.price} timeLeft={closed.timeLeft} state={closed.state} />,
    )
    expect(shut).toMatch(/<path d=""[^>]*data-ring/)
    expect(shut).not.toContain('stroke-dasharray')
  })
})

describe('the last post-buzzer words (refix)', () => {
  it('has no "result pending" over a proposed or challenged result after the final', () => {
    for (const state of ['proposed', 'challenged'] as const) {
      const g = game({ ...over, markets: [market({ status: state })] })
      expect(dialCaption(state, g, null), state).toBe('Final · CLE lost')
      const label = dialLabel({
        game: g,
        outcome: null,
        price: 0.77,
        modelProb: 0.74,
        state,
        secsLeft: 100,
      })
      expect(label.match(/result (pending|proposed|under review)/g), state).toHaveLength(1)
    }
    expect(dialCaption('closed', atBuzzer, null)).toBe('Final · CLE lost · result pending')
  })

  it('reads the external-LP note as the close once the game is final', () => {
    const final = externalLpNote({ status: 'final' })
    expect(final).not.toMatch(/halt/i)
    expect(final).toContain('final buzzer')
    expect(externalLpNote({ status: 'live' })).toContain('after a halt')
    const r: Resolution = {
      market: open.pubkey,
      kind: 'winner',
      status: 'halted',
      outcome: null,
      evidenceHash: null,
      evidenceUrl: null,
      createSig: null,
      haltSig: null,
      proposeSig: null,
      finalizeSig: null,
      recycleSig: null,
      externalLp: true,
      gameMarket: 'GameMarket11111111111111111111111111111111',
      proposedAt: null,
      challengeEndsAt: null,
    }
    const card = renderToStaticMarkup(
      <ResolutionCard game={detail({ ...over, resolutions: [r] })} state="closed" now={NOW} />,
    )
    expect(card).toContain(final.replaceAll("'", '&#x27;'))
    expect(card).not.toMatch(/after a halt/)
  })

  it('reads the crown dial as the scoreboard after the buzzer (aria-label, rendered)', () => {
    const html = crown({ check: checkTrade(buyInput({ gameStatus: 'final' })) }, 'closed')
    expect(html).toContain('aria-label="Final, CLE lost, result pending, 77%"')
    expect(html).not.toMatch(/aria-label="[^"]*to win/)
  })
})
