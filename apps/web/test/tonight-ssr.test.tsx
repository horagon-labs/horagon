import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HERO_LINE, HERO_STEPS, HERO_SUB, Hero } from '../components/chrono/hero'
import { TonightBoard } from '../components/tonight-board'
import { WalletProvider } from '../components/wallet'
import { evening, NOW } from '../lib/chrono/fixtures'
import type { InitialBoard } from '../lib/server/initial'

const page = (initial: InitialBoard) =>
  renderToStaticMarkup(
    <WalletProvider>
      <Hero />
      <TonightBoard initial={initial} />
    </WalletProvider>,
  )

describe('the first frame of / (R5)', () => {
  it('says what Horagon is and the three steps, word for word', () => {
    expect(HERO_LINE).toBe(
      'Call NBA games live. Prices move with every run. Open until the final buzzer.',
    )
    expect(HERO_SUB).toBe('Play money on Solana devnet.')
    expect(HERO_STEPS).toEqual([
      "Pick tonight's game.",
      'Back a team: each share pays 1 mUSDC if it wins.',
      'Watch the price move with the game; claim after the result.',
    ])
    const html = renderToStaticMarkup(<Hero />)
    expect(html).toContain('<h1 id="hero-title"')
    expect(html.match(/<li /g)).toHaveLength(3)
  })

  it('renders the rows from the server data, never "Loading games…"', () => {
    const html = page({ games: evening(), upcoming: null, now: NOW })
    expect(html).toContain('data-hero')
    expect(html.match(/href="\/game\//g)).toHaveLength(5)
    expect(html).toContain('MIL to win')
    expect(html).not.toContain('Loading games…')
    // The hero comes before the first row in the HTML.
    expect(html.indexOf('data-hero')).toBeLessThan(html.indexOf('href="/game/'))
  })

  it('puts the rows before the Night dial in the DOM, and folds the follow chips', () => {
    const html = page({ games: evening(), upcoming: null, now: NOW })
    // Focus and screen readers meet the rows first, as a phone shows them (WCAG 2.4.3); only the
    // desktop grid moves the dial column first.
    const rows = html.indexOf('href="/game/')
    const dial = html.indexOf('role="listbox"')
    expect(rows).toBeGreaterThan(0)
    expect(dial).toBeGreaterThan(rows)
    expect(html.indexOf('data-board-list')).toBeLessThan(dial)
    expect(html).toMatch(/<div class="[^"]*lg:order-first[^"]*"><div role="listbox"/)
    expect(html).not.toMatch(/\border-[12]\b/)
    expect(html).toMatch(/<details[^>]*data-follow[^>]*><summary[^>]*>☆ Follow teams/)
    expect(html).toContain('Tonight&#x27;s games')
  })

  it('says when the next games are on a night without any', () => {
    const tip = Date.parse('2026-11-28T00:00:00.000Z') / 1000
    const html = page({ games: [], upcoming: { tip, count: 4 }, now: NOW })
    expect(html).toContain('Next games: Fri, Nov 27 · 4 games from 7:00 PM ET')
    expect(html).toContain('No NBA games in the next 24 hours.')
  })

  it('falls back to the browser poll when the server had no data', () => {
    const html = page({ games: undefined, upcoming: null, now: NOW })
    expect(html).toContain('Loading games…')
  })
})
