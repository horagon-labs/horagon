import { PLAY_MONEY_NOTICE } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ShareCard, ShareGauge } from '../components/share-card'
import { detail, market, NOW } from '../lib/chrono/fixtures'
import { fullTitle, gameCard, gameMeta, SITE_DESCRIPTION, siteUrl } from '../lib/meta'
import { shareAction, shareEnv, shareLabel } from '../lib/share'

// CLE (home) 84, MEM (away) 78, Q3 4:12, the winner market at 77% in the fixtures.
const finalGame = (outcome: 'yes' | 'no' | null, status: 'open' | 'finalized' = 'open') =>
  detail({
    status: 'final',
    homeScore: 104,
    awayScore: 110,
    period: 4,
    clockSecs: null,
    markets: [market({ status, outcome, endTs: NOW - 600, priceTs: NOW - 700 })],
  })

describe('gameMeta (R5)', () => {
  it('titles a live game "MEM @ CLE · CLE to win 77%", the layout adds " · Horagon"', () => {
    const m = gameMeta(detail(), NOW)
    expect(m.title).toBe('MEM @ CLE · CLE to win 77%')
    expect(fullTitle(m.title)).toBe('MEM @ CLE · CLE to win 77% · Horagon')
    expect(m.description).toBe(`CLE to win · 77%. MEM 78–84 CLE · Q3 4:12. ${PLAY_MONEY_NOTICE}`)
  })

  it('follows the scoreboard after the final buzzer, then the result', () => {
    expect(gameMeta(finalGame(null), NOW).title).toBe(
      'MEM @ CLE · Final · CLE lost · result pending',
    )
    expect(gameMeta(finalGame('no', 'finalized'), NOW).title).toBe('MEM @ CLE · Resolved: MEM won')
  })

  it('names the tip-off before the game, and says postponed or canceled', () => {
    const pre = detail({
      status: 'scheduled',
      homeScore: 0,
      awayScore: 0,
      scheduledTipoff: '2026-11-25T03:30:00.000Z',
      markets: [],
    })
    expect(gameMeta(pre, NOW).title).toBe('MEM @ CLE · CLE to win')
    expect(gameCard(pre, NOW).line).toBe('Tip-off Tue, Nov 24 · 10:30 PM ET')
    expect(gameCard(pre, NOW).price).toBeNull()
    expect(gameCard(detail({ status: 'postponed', markets: [] }), NOW).headline).toBe(
      'Game postponed',
    )
    expect(gameCard(detail({ status: 'canceled', markets: [] }), NOW).headline).toBe(
      'Game canceled',
    )
  })

  it('falls back to the site description without a game', () => {
    expect(gameMeta(undefined, NOW)).toEqual({ title: 'NBA game', description: SITE_DESCRIPTION })
    expect(SITE_DESCRIPTION).toContain(PLAY_MONEY_NOTICE)
  })
})

describe('siteUrl (R5)', () => {
  it('takes HORAGON_PUBLIC_URL, and localhost when it is unset or not a URL', () => {
    expect(siteUrl('https://horagon.test').origin).toBe('https://horagon.test')
    expect(siteUrl(undefined).origin).toBe('http://localhost:3000')
    expect(siteUrl('').origin).toBe('http://localhost:3000')
    expect(siteUrl('not a url').origin).toBe('http://localhost:3000')
  })
})

describe('ShareCard (R5)', () => {
  it('draws the needle at the price, and none without one', () => {
    const live = renderToStaticMarkup(<ShareGauge price={0.62} size={420} />)
    expect(live).toContain('data-needle')
    expect(live).toContain('data-arc')
    const after = renderToStaticMarkup(<ShareGauge price={0.62} size={420} live={false} />)
    expect(after).not.toContain('#d9f99d')
    expect(gameCard(detail(), NOW).live).toBe(true)
    expect(gameCard(finalGame(null), NOW).live).toBe(false)
    const none = renderToStaticMarkup(<ShareGauge price={null} size={420} />)
    expect(none).not.toContain('data-needle')
    expect(none).not.toContain('data-arc')
  })

  it('carries the matchup, the line, the headline and the play-money line', () => {
    const c = gameCard(detail(), NOW)
    const html = renderToStaticMarkup(
      <ShareCard title={c.matchup} line={c.line} headline={c.headline} price={c.price} />,
    )
    for (const words of ['MEM @ CLE', 'MEM 78–84 CLE · Q3 4:12', 'CLE to win · 77%']) {
      expect(html).toContain(words)
    }
    expect(html).toContain(PLAY_MONEY_NOTICE)
    expect(html).not.toContain('NaN')
  })
})

describe('shareAction (R5)', () => {
  const data = { title: 't', text: 'x', url: 'https://horagon.test/game/nba-1' }

  it('uses the share sheet first', async () => {
    const share = vi.fn(async () => {})
    const writeText = vi.fn(async () => {})
    expect(await shareAction({ share, writeText }, data)).toBe('shared')
    expect(share).toHaveBeenCalledWith(data)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('treats a closed sheet as a choice, and any other failure as a reason to copy', async () => {
    const abort = Object.assign(new Error('closed'), { name: 'AbortError' })
    const writeText = vi.fn(async () => {})
    expect(await shareAction({ share: () => Promise.reject(abort), writeText }, data)).toBe(
      'cancelled',
    )
    expect(writeText).not.toHaveBeenCalled()
    const denied = Object.assign(new Error('no'), { name: 'NotAllowedError' })
    expect(await shareAction({ share: () => Promise.reject(denied), writeText }, data)).toBe(
      'copied',
    )
    expect(writeText).toHaveBeenCalledWith(data.url)
  })

  it('copies the link without a share sheet, and fails without either', async () => {
    expect(await shareAction({ writeText: async () => {} }, data)).toBe('copied')
    expect(await shareAction({ writeText: () => Promise.reject(new Error('no')) }, data)).toBe(
      'failed',
    )
    expect(await shareAction({}, data)).toBe('failed')
  })

  it('reads the browser, and says when the link is copied', () => {
    expect(shareEnv(undefined)).toEqual({})
    const nav = { share: vi.fn(), clipboard: { writeText: vi.fn() } } as unknown as Navigator
    const env = shareEnv(nav)
    expect(typeof env.share).toBe('function')
    expect(typeof env.writeText).toBe('function')
    expect(shareEnv({} as Navigator)).toEqual({})
    expect(shareLabel('copied')).toBe('Link copied')
    expect(shareLabel(null)).toBe('Share')
    expect(shareLabel('failed')).toBe('Share')
  })
})
