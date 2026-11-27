// Culture A2 (R8), the pure parts: stop.ts (the buzzer index, when a Buzzer stop plays, strings
// 14 and 15, the ◆ at the average entry), clutch.ts (each gate edge, string 12, the spring, the
// chip, the run flash), story.ts (UPSET, COMEBACK, OVERTIME), the horn read as the close at the
// buzzer (dial state, trade form), the Feel switch and the haptic pattern.
import { describe, expect, it } from 'vitest'
import {
  CLUTCH_SWITCH,
  clutchLine,
  isClutch,
  moveChip,
  pointsMoved,
  runFlashes,
  springBounce,
} from '../lib/chrono/clutch'
import { DEFAULT_FEEL, loadFeel } from '../lib/chrono/feel'
import { detail, game, history, market, NOW, position } from '../lib/chrono/fixtures'
import { buzz } from '../lib/chrono/haptics'
import { deriveDialState } from '../lib/chrono/state'
import {
  atBuzzer,
  averageEntry,
  entryMark,
  holderLine,
  isHornFrame,
  isStoppedFace,
  NEW_STOP_MEMORY,
  STOP_BUZZ,
  STOP_SPOKEN,
  stopLine,
  stopPrice,
  stopStep,
} from '../lib/chrono/stop'
import { homeWon, storyOf } from '../lib/chrono/story'
import { BUZZER_CLOSED, checkTrade } from '../lib/trade-form'

const MKT = market().pubkey

describe('the horn (stop.ts)', () => {
  const horn = { status: 'live' as const, period: 4, clockSecs: 0, homeScore: 107, awayScore: 105 }

  it('is Q4 or later at 0:00 with the scores apart', () => {
    expect(isHornFrame(horn)).toBe(true)
    expect(isHornFrame({ ...horn, period: 5 })).toBe(true)
    expect(isHornFrame({ ...horn, awayScore: 107 })).toBe(false)
    expect(isHornFrame({ ...horn, period: 3 })).toBe(false)
    expect(isHornFrame({ ...horn, clockSecs: 1 })).toBe(false)
    expect(isHornFrame({ ...horn, status: 'final' })).toBe(false)
  })

  it('reads the Final, or the horn frame, halted or not yet, as the buzzer', () => {
    expect(atBuzzer({ ...horn, status: 'final', clockSecs: null })).toBe(true)
    // Halted or before the keeper's halt lands (it holds the frame 10 s first), as for the Final.
    expect(atBuzzer(horn)).toBe(true)
    expect(atBuzzer({ ...horn, clockSecs: 40 })).toBe(false)
    expect(atBuzzer({ ...horn, awayScore: 107 })).toBe(false)
  })

  it('draws a horn-halted market closed, not "Trading halted"', () => {
    const halted = market({ status: 'halted' })
    expect(deriveDialState(horn, halted, NOW)).toBe('closed')
    // A halt with time still on the clock stays the amber halt.
    expect(deriveDialState({ ...horn, clockSecs: 300 }, halted, NOW)).toBe('halted')
    expect(deriveDialState({ ...horn, awayScore: 107 }, halted, NOW)).toBe('halted')
  })

  it('draws the horn frame closed before the halt lands, as the Final (R5c)', () => {
    const open = market({ status: 'open' })
    expect(deriveDialState(horn, open, NOW)).toBe('closed')
    // A tie at 0:00 goes to overtime: still trading.
    expect(deriveDialState({ ...horn, awayScore: 107 }, open, NOW)).toBe('live')
    expect(deriveDialState({ ...horn, clockSecs: 1 }, open, NOW)).toBe('live')
  })

  it('tells the trade form the buzzer closed it', () => {
    const base = {
      action: 'buy' as const,
      amount: '10',
      balance: '100',
      shares: undefined,
      marketStatus: 'halted' as const,
      gameStatus: 'live' as const,
      endTs: NOW + 600,
      nowSecs: NOW,
    }
    expect(checkTrade({ ...base, hornFrame: true }).reason).toBe(BUZZER_CLOSED)
    expect(checkTrade({ ...base, hornFrame: false }).reason).toBe('Trading is halted.')
    expect(checkTrade(base).reason).toBe('Trading is halted.')
    // Before the halt lands, the horn frame closes the form too: no Buy on a decided game.
    const open = { ...base, marketStatus: 'open' as const }
    expect(checkTrade({ ...open, hornFrame: true })).toMatchObject({
      ok: false,
      quote: false,
      reason: BUZZER_CLOSED,
    })
    expect(checkTrade({ ...open, hornFrame: false }).ok).toBe(true)
  })

  it('never reads halftime or the end of Q1 to Q3 at 0:00 as the horn: it still trades', () => {
    // ESPN halftime and the end of Q1 to Q3 read 0 s with the scores apart.
    const open = market({ status: 'open' })
    for (const period of [1, 2, 3]) {
      const end = { ...horn, period }
      expect(isHornFrame(end)).toBe(false)
      expect(atBuzzer(end)).toBe(false)
      expect(deriveDialState(end, open, NOW)).toBe('live')
      expect(isClutch({ state: 'live', price: 0.5, game: end, enabled: true })).toBe(false)
    }
    const base = {
      action: 'buy' as const,
      amount: '10',
      balance: '100',
      shares: undefined,
      marketStatus: 'open' as const,
      gameStatus: 'live' as const,
      hornFrame: isHornFrame({ ...horn, period: 2 }),
      endTs: NOW + 600,
      nowSecs: NOW,
    }
    expect(checkTrade(base).ok).toBe(true)
  })
})

describe('the buzzer index and the Buzzer stop (stop.ts)', () => {
  it('shows on every stopped face, not on a trading or halted one', () => {
    for (const s of ['closed', 'proposed', 'challenged', 'resolved'] as const) {
      expect(isStoppedFace(s)).toBe(true)
    }
    for (const s of ['live', 'pre', 'closing', 'halted', 'void'] as const) {
      expect(isStoppedFace(s)).toBe(false)
    }
  })

  it('stands at the last price at or before the stop, else the current price', () => {
    const h = history()
    // Prices at NOW-800 (74) and NOW-660 (77) for this market, and another market's.
    expect(stopPrice(h, MKT, NOW - 660, 0.5)).toBe(0.77)
    expect(stopPrice(h, MKT, NOW - 661, 0.5)).toBe(0.74)
    expect(stopPrice(h, MKT, NOW - 900, 0.5)).toBe(0.5)
    expect(stopPrice(undefined, MKT, NOW, 0.62)).toBe(0.62)
    expect(stopPrice(undefined, MKT, NOW, null)).toBeNull()
  })

  it('plays once, only after the page saw the market trade, never on load', () => {
    // Opened after the buzzer: never.
    let m = stopStep(NEW_STOP_MEMORY, { trading: false, buzzer: true })
    expect(m.play).toBe(false)
    m = stopStep(m.memory, { trading: false, buzzer: true })
    expect(m.play).toBe(false)
    // Saw it open, then the buzzer: once.
    let s = stopStep(NEW_STOP_MEMORY, { trading: true, buzzer: false })
    expect(s.play).toBe(false)
    s = stopStep(s.memory, { trading: false, buzzer: true })
    expect(s.play).toBe(true)
    s = stopStep(s.memory, { trading: false, buzzer: true })
    expect(s.play).toBe(false)
    // A halt mid-game is not the buzzer.
    const h = stopStep(stopStep(NEW_STOP_MEMORY, { trading: true, buzzer: false }).memory, {
      trading: false,
      buzzer: false,
    })
    expect(h.play).toBe(false)
  })

  it('says strings 14 and 15', () => {
    expect(STOP_SPOKEN).toBe('Stopped at the buzzer')
    const g = game({ home: 'CHA', away: 'CHI', homeScore: 105, awayScore: 107 })
    expect(stopLine(g)).toBe('Stopped at the buzzer · CHI 107–105 CHA')
    const g2 = game({ id: 'nba-1', home: 'CLE', away: 'MEM' })
    // 3.8 mUSDC for 10 CLE shares: 38%; the horn price had CLE at 71%.
    const mine = [position({ gameId: 'nba-1', shares: '10', costUsdc: '3.8' })]
    expect(holderLine(g2, mine, 0.71)).toBe(
      'You backed CLE at 38%. At the horn the price had CLE at 71%.',
    )
    const away = [position({ gameId: 'nba-1', side: 'away', shares: '10', costUsdc: '6' })]
    expect(holderLine(g2, away, 0.71)).toBe(
      'You backed MEM at 60%. At the horn the price had MEM at 29%.',
    )
    expect(holderLine(g2, [], 0.71)).toBeNull()
    expect(holderLine(g2, mine, null)).toBeNull()
    expect(holderLine(g2, [position({ gameId: 'nba-2' })], 0.71)).toBeNull()
  })

  it('puts the ◆ at the average entry, 1 − it for an away position', () => {
    expect(averageEntry({ shares: '10', costUsdc: '3.8' })).toBeCloseTo(0.38, 9)
    expect(averageEntry({ shares: '0', costUsdc: '0' })).toBeNull()
    const home = [position({ gameId: 'nba-1', shares: '10', costUsdc: '3.8' })]
    expect(entryMark(home, 'nba-1')).toBeCloseTo(0.38, 9)
    const away = [position({ gameId: 'nba-1', side: 'away', shares: '10', costUsdc: '6' })]
    expect(entryMark(away, 'nba-1')).toBeCloseTo(0.4, 9)
    expect(entryMark(undefined, 'nba-1')).toBeNull()
    expect(entryMark([position({ gameId: 'nba-1', shares: '0' })], 'nba-1')).toBeNull()
  })

  it('buzzes a holder short, pause, short through buzz()', () => {
    expect(STOP_BUZZ).toEqual([30, 80, 30])
    const calls: unknown[] = []
    const nav = {
      vibrate: (p: number | number[]) => {
        calls.push(p)
        return true
      },
    }
    expect(buzz(DEFAULT_FEEL, STOP_BUZZ, nav)).toBe(true)
    expect(calls).toEqual([[30, 80, 30]])
    expect(buzz({ ...DEFAULT_FEEL, haptics: false }, STOP_BUZZ, nav)).toBe(false)
  })
})

describe('clutch time (clutch.ts)', () => {
  const q4 = { status: 'live' as const, period: 4, clockSecs: 108 }
  const on = { state: 'live' as const, price: 0.5, game: q4, enabled: true }

  it('passes each gate edge: 10% and 90% in, 9.9% and 90.1% out', () => {
    expect(isClutch(on)).toBe(true)
    expect(isClutch({ ...on, price: 0.1 })).toBe(true)
    expect(isClutch({ ...on, price: 0.9 })).toBe(true)
    expect(isClutch({ ...on, price: 0.099 })).toBe(false)
    expect(isClutch({ ...on, price: 0.901 })).toBe(false)
    expect(isClutch({ ...on, price: null })).toBe(false)
  })

  it('starts at 2:00 of Q4 (120 s in, 121 s out), and covers all of overtime', () => {
    expect(isClutch({ ...on, game: { ...q4, clockSecs: 120 } })).toBe(true)
    expect(isClutch({ ...on, game: { ...q4, clockSecs: 121 } })).toBe(false)
    expect(isClutch({ ...on, game: { ...q4, period: 3, clockSecs: 60 } })).toBe(false)
    expect(isClutch({ ...on, game: { ...q4, period: 5, clockSecs: 290 } })).toBe(true)
    expect(isClutch({ ...on, game: { ...q4, period: 6, clockSecs: null } })).toBe(true)
    expect(isClutch({ ...on, game: { ...q4, clockSecs: null } })).toBe(false)
  })

  it('needs the market trading, the game live and the Feel switch on', () => {
    expect(isClutch({ ...on, enabled: false })).toBe(false)
    expect(isClutch({ ...on, state: 'closing' })).toBe(true)
    expect(isClutch({ ...on, state: 'halted' })).toBe(false)
    expect(isClutch({ ...on, state: 'closed' })).toBe(false)
    expect(isClutch({ ...on, game: { ...q4, status: 'final' } })).toBe(false)
  })

  it('is never clutch at 0:00 of Q4 or an overtime: the clock has stopped', () => {
    // Even with the face still trading (the halt not landed yet), the horn frame is no clutch.
    expect(isClutch({ ...on, game: { ...q4, clockSecs: 0 } })).toBe(false)
    expect(isClutch({ ...on, game: { ...q4, period: 5, clockSecs: 0 } })).toBe(false)
    expect(isClutch({ ...on, game: { ...q4, clockSecs: 1 } })).toBe(true)
  })

  it('says string 12 and names its switch', () => {
    expect(clutchLine({ ...detail(), ...q4 })).toBe(
      'Clutch · Q4 1:48 · open until the final buzzer',
    )
    expect(CLUTCH_SWITCH).toBe('Dim the screen in clutch time')
    expect(DEFAULT_FEEL.clutchDim).toBe(true)
    expect(loadFeel(null).clutchDim).toBe(true)
    const stored = { getItem: () => JSON.stringify({ clutchDim: false }), setItem: () => {} }
    expect(loadFeel(stored).clutchDim).toBe(false)
  })
})

describe('the needle moves (clutch.ts)', () => {
  it('bounces with the move, from 0.15 up to 0.30', () => {
    expect(springBounce(0)).toBeCloseTo(0.15, 9)
    expect(springBounce(0.05)).toBeCloseTo(0.225, 9)
    expect(springBounce(-0.05)).toBeCloseTo(0.225, 9)
    expect(springBounce(0.5)).toBe(0.3)
    expect(springBounce(Number.NaN)).toBeCloseTo(0.15, 9)
  })

  it('prints a "+5" or "−5" chip (U+2212) for 3 points or more', () => {
    expect(moveChip(0.62, 0.67)).toBe('+5')
    expect(moveChip(0.67, 0.62)).toBe('−5')
    expect(moveChip(0.67, 0.62)).not.toContain('-')
    expect(moveChip(0.62, 0.65)).toBe('+3')
    expect(moveChip(0.62, 0.64)).toBeNull()
    expect(moveChip(null, 0.6)).toBeNull()
    expect(pointsMoved(0.774, 0.776)).toBe(1)
  })

  it('flashes the ring for a run that moved the price 2 points or more', () => {
    expect(runFlashes(0.74, 0.77)).toBe(true)
    expect(runFlashes(0.74, 0.76)).toBe(true)
    expect(runFlashes(0.74, 0.75)).toBe(false)
    expect(runFlashes(0.62, 0.62)).toBe(false)
    expect(runFlashes(null, 0.7)).toBe(false)
  })
})

describe('the story plate (story.ts)', () => {
  const final = (over = {}) =>
    game({ status: 'final', homeScore: 110, awayScore: 101, period: 4, ...over })
  const snaps = (modelProbs: (number | null)[]) => ({
    gameId: 'nba-401810001',
    prices: [],
    snapshots: modelProbs.map((m, i) => ({
      ts: NOW + i,
      homeScore: 0,
      awayScore: 0,
      period: i === 0 ? 0 : 2,
      clockSecs: 300,
      modelProb: m,
    })),
  })

  it('knows the winner from the result, else the final score', () => {
    expect(homeWon(final(), 'no')).toBe(false)
    expect(homeWon(final(), null)).toBe(true)
    expect(homeWon(game(), null)).toBeNull()
  })

  it('UPSET: the winner opened at 33% or less', () => {
    expect(storyOf(final(), market({ initialPriceBps: 3_300 }), undefined)).toBe('Upset')
    expect(storyOf(final(), market({ initialPriceBps: 3_301 }), undefined)).toBeNull()
    // An away winner reads 1 − the home price.
    expect(storyOf(final({ homeScore: 90 }), market({ initialPriceBps: 6_700 }), undefined)).toBe(
      'Upset',
    )
  })

  it('COMEBACK: the model had the winner at 10% or less while live', () => {
    const m = market({ initialPriceBps: 6_000 })
    expect(storyOf(final(), m, snaps([0.6, 0.1, 0.8]))).toBe('Comeback')
    expect(storyOf(final(), m, snaps([0.6, 0.11, 0.8]))).toBeNull()
    // A pre-game snapshot (period 0) does not count.
    expect(storyOf(final(), m, snaps([0.05, 0.5]))).toBeNull()
  })

  it('OVERTIME past Q4, and UPSET first, then COMEBACK', () => {
    const m = market({ initialPriceBps: 6_000 })
    expect(storyOf(final({ period: 5 }), m, undefined)).toBe('Overtime')
    expect(storyOf(final({ period: 5 }), m, snaps([0.6, 0.05]))).toBe('Comeback')
    expect(
      storyOf(final({ period: 5 }), market({ initialPriceBps: 3_000 }), snaps([0.6, 0.05])),
    ).toBe('Upset')
    // No winner yet, no plate but overtime.
    expect(storyOf(game({ period: 4 }), m, undefined)).toBeNull()
  })
})
