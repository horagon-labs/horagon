// The close at the final buzzer (R1, ruling of 2026-11-26): the keeper halts a market on the first
// Final read, so a halted market under a final game is the normal close. Every place that maps
// the dial state shows it as closed, with the final caption, and none shows the amber look of an
// emergency halt. A halt while the game is still on the court stays "Trading halted".
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Dial } from '../components/chrono/dial'
import { RING, stateLine } from '../components/chrono/dial-look'
import { DialRow } from '../components/chrono/dial-row'
import { MiniDial } from '../components/chrono/mini-dial'
import { NightDial } from '../components/chrono/night-dial'
import { boardItem, itemLabel, rowWords } from '../lib/chrono/board'
import { dialCaption, liveNumber, resolutionStatus } from '../lib/chrono/copy'
import { detail, game, market, NOW } from '../lib/chrono/fixtures'
import { canTrade, gameDial } from '../lib/chrono/game'
import { pusherMode } from '../lib/chrono/pusher'
import { gameCard } from '../lib/meta'
import { checkTrade } from '../lib/trade-form'

// CLE (home) lost 104-110 to MEM; the keeper halted the market at the buzzer, end_ts still ahead.
const over = {
  status: 'final' as const,
  homeScore: 104,
  awayScore: 110,
  period: 4,
  clockSecs: null,
}
const halted = market({ status: 'halted' })
const buzzer = game({ ...over, markets: [halted] })
const midGame = game({ markets: [halted] })

describe('a halted market under a final game reads closed (R1 ruling)', () => {
  const item = boardItem(buzzer, undefined, NOW)

  it('is the closed state, with the final caption', () => {
    expect(item.state).toBe('closed')
    expect(dialCaption(item.state, buzzer, null)).toBe('Final · CLE lost · result pending')
    const won = game({ ...over, homeScore: 110, awayScore: 104, markets: [halted] })
    const wonItem = boardItem(won, undefined, NOW)
    expect(dialCaption(wonItem.state, won, null)).toBe('Final · CLE won · result pending')
    expect(boardItem(midGame, undefined, NOW).state).toBe('halted')
  })

  it('rings in ash on the dial and the row, never the amber or the hatching of a halt', () => {
    expect(RING[item.state]).toBe('stroke-ash-400')
    const dial = renderToStaticMarkup(
      <Dial
        price={item.price}
        modelProb={0.74}
        timeLeft={item.timeLeft}
        state={item.state}
        label={itemLabel(item)}
        caption={dialCaption(item.state, buzzer, null)}
      />,
    )
    expect(dial).not.toContain('stroke-amber-400')
    expect(dial).not.toContain('stroke-dasharray="3 3"')
    expect(dial).toContain('font-mono tabular-nums text-ash-400')
    expect(stateLine(item.state, buzzer, item.secsLeft, NOW)).toBe(
      'Stopped at the buzzer · MEM 110–104 CLE',
    )
    const mini = renderToStaticMarkup(
      <MiniDial price={item.price} timeLeft={item.timeLeft} state={item.state} />,
    )
    expect(mini).not.toContain('stroke-amber-400')
    expect(mini).not.toContain('stroke-dasharray="3 3"')
  })

  it('reads "CLE lost · 77% · result pending" on its row, in ash and with no time', () => {
    expect(rowWords(item, NOW)).toEqual({
      subject: 'CLE lost',
      value: '77%',
      model: false,
      note: 'result pending',
      wide: '',
    })
    expect(liveNumber(item.state)).toBe(false)
    const row = renderToStaticMarkup(<DialRow item={item} now={NOW} />)
    expect(row).toContain('text-ink-muted">77%')
    expect(row).not.toContain('latest')
  })

  it('says "result pending" once, aloud', () => {
    expect(itemLabel(item)).toBe(
      'MEM 110, CLE 104. Final, CLE lost, result pending, 77%, model 74%, trading closed',
    )
  })

  it('draws its Night dial arc in ash', () => {
    const html = renderToStaticMarkup(
      <NightDial items={[item]} now={NOW} selectedId={null} onSelect={() => {}} emptyText="" />,
    )
    expect(html).not.toContain('stroke-amber-400')
    expect(html).toContain('class="stroke-ash-400')
  })

  it('shows the final in the link preview, the needle in ash', () => {
    const card = gameCard(detail({ ...over, markets: [halted] }), NOW)
    expect(card.headline).toBe('Final · CLE lost · result pending')
    expect(card.live).toBe(false)
  })

  it('closes the crown: no Buy, the closed line, the buzzer named in the trade check', () => {
    const d = gameDial(detail({ ...over, markets: [halted] }), halted, null, null, NOW)
    expect(d.state).toBe('closed')
    expect(canTrade(d.state)).toBe(false)
    const pusher = pusherMode({
      state: d.state,
      ready: 'ready',
      balance: '10',
      effect: null,
      failedAction: 'buy',
      secsLeft: d.secsLeft,
    })
    expect(pusher).toEqual({
      kind: 'line',
      text: 'Trading closed. The result goes on-chain automatically 3 h after tip-off, then a guardian has 15 minutes to challenge it.',
    })
    expect(resolutionStatus(d.state, buzzer, null)).toBe(
      'Final MEM 110–104 CLE. The result goes on-chain automatically 3 h after tip-off, then a guardian has 15 minutes to challenge it.',
    )
    const check = checkTrade({
      action: 'buy',
      amount: '10',
      balance: '10',
      shares: undefined,
      marketStatus: 'halted',
      gameStatus: 'final',
      endTs: halted.endTs,
      nowSecs: NOW,
    })
    expect(check.reason).toBe('Trading closed at the final buzzer.')
  })

  it('keeps the amber halt for a game still on the court', () => {
    const live = boardItem(midGame, undefined, NOW)
    expect(RING[live.state]).toBe('stroke-amber-400')
    expect(rowWords(live, NOW).note).toBe('trading halted')
    expect(resolutionStatus(live.state, midGame, null)).toBe('Trading halted')
  })
})
