import { describe, expect, it } from 'vitest'
import { boardItem, rowWords } from '../lib/chrono/board'
import {
  dialCaption,
  homeWonOnScore,
  liveNumber,
  MODEL_HINT,
  resolutionStatus,
  rowSubject,
  toWin,
  verdict,
} from '../lib/chrono/copy'
import { game, market, NOW } from '../lib/chrono/fixtures'
import { DIAL_STATES } from '../lib/chrono/state'

// CLE (home) 84, MEM (away) 78 in the fixtures.
const final = (homeScore: number, awayScore: number) =>
  game({ status: 'final', homeScore, awayScore, period: 4, clockSecs: null })

describe('what the number means (R5, audit section 13)', () => {
  it('reads "MEM to win · 62%" with honest edges, and no number while there is no price', () => {
    expect(toWin('MEM', 0.624)).toBe('MEM to win · 62%')
    expect(toWin('MEM', 0.996)).toBe('MEM to win · >99%')
    expect(toWin('MEM', null)).toBe('MEM to win')
  })

  it('says "to win" before and during the game', () => {
    expect(dialCaption('live', game(), null)).toBe('CLE to win')
    expect(dialCaption('pre', game({ status: 'scheduled' }), null)).toBe('CLE to win')
    expect(rowSubject('closing', game(), null)).toBe('CLE to win')
    expect(verdict('halted', game(), null)).toEqual({ kind: 'to-win' })
  })

  it('follows the scoreboard after the final buzzer: never "wins" for the side that lost', () => {
    expect(dialCaption('closed', final(105, 107), null)).toBe('Final · CLE lost · result pending')
    expect(dialCaption('proposed', final(110, 104), null)).toBe('Final · CLE won · result pending')
    expect(dialCaption('challenged', final(105, 107), null)).toBe(
      'Final · CLE lost · result pending',
    )
    expect(rowSubject('closed', final(105, 107), null)).toBe('CLE lost')
    expect(rowSubject('closed', final(110, 104), null)).toBe('CLE won')
    for (const state of DIAL_STATES) {
      expect(dialCaption(state, final(105, 107), null), state).not.toMatch(/CLE (wins|to win)/)
    }
  })

  it('names the result once it is on-chain', () => {
    expect(dialCaption('resolved', final(110, 104), 'yes')).toBe('Resolved: CLE won')
    expect(dialCaption('resolved', final(104, 110), 'no')).toBe('Resolved: MEM won')
    expect(rowSubject('resolved', final(104, 110), 'no')).toBe('Resolved: MEM won')
    // A game postponed for good resolves NO with no winner on the court.
    expect(dialCaption('resolved', game({ status: 'postponed' }), 'no')).toBe(
      'Resolved: CLE did not win',
    )
  })

  it('has no caption for a void game and for a final without a winner on the board', () => {
    expect(dialCaption('void', game({ status: 'canceled' }), null)).toBe('')
    expect(homeWonOnScore(final(100, 100))).toBeNull()
    expect(homeWonOnScore(game())).toBeNull()
    expect(dialCaption('closed', final(100, 100), null)).toBe('Final · result pending')
  })

  it('lights the number only while it is a live chance', () => {
    expect(DIAL_STATES.filter(liveNumber)).toEqual(['halted', 'closing', 'live', 'pre'])
  })

  it('explains the model in place', () => {
    expect(MODEL_HINT).toBe('Model: live win chance from score and clock')
  })
})

describe('rowWords (R5)', () => {
  it('reads subject, percent and close for a live game', () => {
    expect(rowWords(boardItem(game(), undefined, NOW))).toEqual({
      subject: 'CLE to win',
      value: '77%',
      note: 'closes 10:10 PM ET',
    })
  })

  it('says the result is pending once the game is final, and drops the number after it', () => {
    const closed = final(105, 107)
    closed.markets = [market({ endTs: NOW - 60 })]
    expect(rowWords(boardItem(closed, undefined, NOW))).toEqual({
      subject: 'CLE lost',
      value: '77%',
      note: 'result pending',
    })
    const done = final(110, 104)
    done.markets = [market({ status: 'finalized', outcome: 'yes', endTs: NOW - 60 })]
    expect(rowWords(boardItem(done, undefined, NOW))).toEqual({
      subject: 'Resolved: CLE won',
      value: '',
      note: 'result final',
    })
  })

  it('names a market closed under a game still on the court', () => {
    const late = game({ markets: [market({ endTs: NOW - 10, priceTs: NOW - 20 })] })
    expect(rowWords(boardItem(late, undefined, NOW)).note).toBe('trading closed')
  })
})

describe('resolutionStatus (R5, audit finding 11)', () => {
  it('says the state of the dial, not the raw chain status', () => {
    expect(resolutionStatus('live', game(), null)).toBe('Trading open')
    expect(resolutionStatus('closed', game(), null)).toBe(
      'Trading closed. The result goes on-chain after a box-score check.',
    )
    expect(resolutionStatus('closed', final(105, 107), null)).toBe(
      'Final MEM 107–105 CLE. The result goes on-chain after a box-score check.',
    )
    expect(resolutionStatus('proposed', final(105, 107), null)).toBe(
      'Result proposed: the challenge window is open',
    )
    expect(resolutionStatus('challenged', final(105, 107), null)).toBe('Result under review')
    expect(resolutionStatus('resolved', final(105, 107), 'no')).toBe('Resolved: MEM won')
    expect(resolutionStatus('void', game({ status: 'canceled' }), null)).toBe('Game canceled')
    expect(resolutionStatus('halted', game(), null)).toBe('Trading halted')
  })
})
