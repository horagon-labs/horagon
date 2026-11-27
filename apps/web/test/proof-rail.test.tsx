// First screen, slice 2 "Proof rail" (first-screen spec §5 C2b, C5, C6, C6m, §6 rail counts and
// program ids, §7 W6): the mechanism line, both programs linked to the devnet explorer, the real
// counts from GET /record, and the H1's price claim only when a moved market is on screen.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HORAGON_PROGRAM_ID, PM_AMM_PROGRAM_ID, type RecordResponse } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { HERO_LINE, HERO_LINE_MOVED, Hero } from '../components/chrono/hero'
import { MECHANISM_LINE, ProofRail } from '../components/proof-rail'
import { heroMoved } from '../lib/chrono/board'
import { at, game, market, NOW } from '../lib/chrono/fixtures'
import { loadRecord, RECORD_TTL_MS } from '../lib/server/initial'
import { nightRows } from '../lib/server/last-night'

const POOLS = 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y'
const RESULTS = 'HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF'
/** The ET 11-25 story market (MIN @ OKC), finalized on devnet. */
const STORY = '54WUazC5v1tYQm1kY3dZ1n7cAJ1XYw3t3Yb1H9bL2xQ1'
const TODAY: RecordResponse = { markets: 12, final: 12 }

/** The visible text: tags dropped, entities read. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')

/** The element with `attr`, through its closing tag (no nesting of the same tag inside). */
function part(html: string, attr: string): string {
  const at = html.indexOf(attr)
  expect(at, attr).toBeGreaterThan(-1)
  const open = html.lastIndexOf('<', at)
  const tag = /^<(\w+)/.exec(html.slice(open))?.[1] ?? ''
  const close = html.indexOf(`</${tag}>`, at)
  return html.slice(open, close + tag.length + 3)
}

describe('the proof rail (C5, C6, C6m)', () => {
  const html = renderToStaticMarkup(<ProofRail record={TODAY} proofMarket={STORY} />)

  it('reads the program ids from the SDK, the ones the spec names', () => {
    expect(PM_AMM_PROGRAM_ID.toBase58()).toBe(POOLS)
    expect(HORAGON_PROGRAM_ID.toBase58()).toBe(RESULTS)
  })

  it('says how a share pays and why a late call moves the price more, word for word', () => {
    expect(MECHANISM_LINE).toBe(
      'Each share pays 1 mUSDC if its team wins. One pm-AMM pool per game; its liquidity thins toward a fixed end time, so a late call moves the price more.',
    )
    expect(text(part(html, 'data-mechanism'))).toBe(MECHANISM_LINE)
  })

  it('names both programs and the real counts on the desktop rail', () => {
    expect(text(part(html, 'data-rail-wide'))).toBe(
      'Pools: pm-AMM GV1F…N16y ↗ · Results: Horagon program HtDJ…9qHF ↗ · 12 markets created · 12 results final on chain · How the model is checked',
    )
    const devnet = (k: string) => `https://explorer.solana.com/address/${k}?cluster=devnet`
    expect(html).toContain(`href="${devnet(POOLS)}"`)
    expect(html).toContain(`href="${devnet(RESULTS)}"`)
    // Each link carries its program's name, so the two never read as one.
    expect(html).toMatch(
      new RegExp(`href="${devnet(POOLS).replace(/[?.]/g, '\\$&')}"[^>]*>pm-AMM `),
    )
    expect(html).toMatch(
      new RegExp(`href="${devnet(RESULTS).replace(/[?.]/g, '\\$&')}"[^>]*>Horagon program `),
    )
    expect(html).toContain('href="/study"')
  })

  it('folds to one line at 375 that opens the story market on /verify', () => {
    const narrow = part(html, 'data-rail-narrow')
    expect(text(narrow)).toBe('12 markets · 12 results on chain ↗')
    expect(narrow).toContain(`href="/verify/${STORY}"`)
    // One rail per width: the narrow one hides from sm up, the wide one below sm.
    expect(narrow).toMatch(/class="[^"]*\bsm:hidden\b/)
    expect(part(html, 'data-rail-wide')).toMatch(/class="[^"]*\bhidden\b[^"]*\bsm:block\b/)
    expect(part(html, 'data-mechanism')).toMatch(/class="[^"]*\bhidden\b[^"]*\bsm:block\b/)
  })

  it('makes every link a 44 px tap target, in mono 12, with no Live blue and no style attribute', () => {
    const links = html.match(/<a [^>]*>/g) ?? []
    expect(links).toHaveLength(4)
    for (const a of links) expect(a).toMatch(/\bmin-h-11\b/)
    expect(html).toContain('data-proof-rail')
    expect(part(html, 'data-rail-wide')).toMatch(
      /\bfont-mono\b[^"]*\btext-12\b|\btext-12\b[^"]*\bfont-mono\b/,
    )
    expect(html).not.toMatch(/\btext-live\b|\bbg-live\b|\bborder-live\b/)
    expect(html).not.toContain('style=')
    // The explorer opens in a new tab; the arrow is not read out.
    expect(html.match(/target="_blank" rel="noreferrer"/g)).toHaveLength(2)
    expect(html.match(/<span aria-hidden="true">↗<\/span>/g)).toHaveLength(3)
  })

  it('says 1 market and 1 result in the singular', () => {
    const one = renderToStaticMarkup(
      <ProofRail record={{ markets: 1, final: 1 }} proofMarket={STORY} />,
    )
    expect(text(part(one, 'data-rail-narrow'))).toBe('1 market · 1 result on chain ↗')
    expect(text(part(one, 'data-rail-wide'))).toContain(
      '· 1 market created · 1 result final on chain ·',
    )
    const none = renderToStaticMarkup(
      <ProofRail record={{ markets: 3, final: 0 }} proofMarket={STORY} />,
    )
    expect(text(part(none, 'data-rail-wide'))).toContain(
      '· 3 markets created · 0 results final on chain ·',
    )
  })

  it('links the Horagon program at 375 when there is no story market to open', () => {
    const html = renderToStaticMarkup(<ProofRail record={TODAY} proofMarket={null} />)
    const narrow = part(html, 'data-rail-narrow')
    expect(narrow).toContain(`href="https://explorer.solana.com/address/${RESULTS}?cluster=devnet"`)
    expect(narrow).toContain('target="_blank"')
  })

  it('shows the program links at every width and no count when the counts are unknown or zero', () => {
    for (const record of [null, { markets: 0, final: 0 }]) {
      const html = renderToStaticMarkup(<ProofRail record={record} proofMarket={STORY} />)
      expect(html).not.toContain('data-rail-narrow')
      expect(text(part(html, 'data-rail-wide'))).toBe(
        'Pools: pm-AMM GV1F…N16y ↗ · Results: Horagon program HtDJ…9qHF ↗ · How the model is checked',
      )
      expect(part(html, 'data-rail-wide')).not.toMatch(/class="[^"]*\bhidden\b/)
      expect(html).not.toMatch(/\bmarkets?\b.*created/)
    }
  })
})

describe('the hero with the rail (C2b, C5 at 375)', () => {
  it('claims a price move only through `moved`', () => {
    expect(HERO_LINE_MOVED).toBe(
      'Call the winner while the NBA game is on. Prices move with every run. Open until the final buzzer.',
    )
    const flat = renderToStaticMarkup(<Hero />)
    expect(flat).toContain(`>${HERO_LINE}</h1>`)
    expect(flat).not.toContain('Prices move')
    expect(renderToStaticMarkup(<Hero moved={false} />)).toBe(flat)
    const moved = renderToStaticMarkup(<Hero moved />)
    expect(moved).toContain(`>${HERO_LINE_MOVED}</h1>`)
  })

  it('puts the mechanism line after the steps in "How it works" below sm only', () => {
    const html = renderToStaticMarkup(<Hero />)
    const how = part(html, 'data-how')
    const line = part(how, 'data-how-mechanism')
    expect(text(line)).toBe(MECHANISM_LINE)
    expect(line).toMatch(/class="[^"]*\bsm:hidden\b/)
    expect(how.indexOf('data-how-mechanism')).toBeGreaterThan(how.lastIndexOf('<li'))
  })
})

describe('heroMoved: when the H1 may say "Prices move with every run." (C2b)', () => {
  // NOW is 9:08 PM ET; the fixture game is live in Q3 with its winner market open at 77%.
  const open = (price: number | null, initialPriceBps = 5_000) =>
    game({ markets: [market({ price, initialPriceBps })] })
  const later = game({
    id: 'nba-401810009',
    status: 'scheduled',
    homeScore: 0,
    awayScore: 0,
    period: 0,
    clockSecs: null,
    scheduledTipoff: new Date((NOW + 5 * 3600) * 1000).toISOString(),
    markets: [],
  })

  it('in S3/S4, says so when a listed market moved from its open, and not when none did', () => {
    expect(heroMoved([open(0.77)], NOW)).toBe(true)
    expect(heroMoved([open(0.5)], NOW)).toBe(false)
    expect(heroMoved([open(0.5), later], NOW)).toBe(false)
    // round(price · 1e4) against the opening bps, as the rows do.
    expect(heroMoved([open(0.50004)], NOW)).toBe(false)
    expect(heroMoved([open(0.5001)], NOW)).toBe(true)
    // An open market with no indexed price has not moved.
    expect(heroMoved([open(null)], NOW)).toBe(false)
    // The story's move does not count while a market trades: the board speaks for itself.
    expect(heroMoved([open(0.5)], NOW, true)).toBe(false)
  })

  it('with no market open (S1, S2, S5), follows the story alone', () => {
    expect(heroMoved([later], NOW)).toBe(false)
    expect(heroMoved([later], NOW, true)).toBe(true)
    expect(heroMoved([], NOW)).toBe(false)
    expect(heroMoved([], NOW, true)).toBe(true)
    expect(heroMoved(undefined, NOW)).toBe(false)
    expect(heroMoved(undefined, NOW, true)).toBe(true)
    // A moved market whose game is over and off the 24 h list is not on screen.
    const old = game({
      status: 'final',
      scheduledTipoff: new Date(at('2026-11-23T00:00:00Z') * 1000).toISOString(),
      markets: [market({ status: 'finalized', price: 0.9, outcome: 'yes' })],
    })
    expect(heroMoved([old, later], NOW)).toBe(false)
  })
})

describe('the record loader (§7 W6)', () => {
  it('keeps the counts for 60 s', () => {
    expect(RECORD_TTL_MS).toBe(60_000)
  })

  it('returns the counts, or null when the API fails or is late, and never throws', async () => {
    const ok = { record: vi.fn(async () => TODAY) }
    expect(await loadRecord(ok, 50)).toEqual(TODAY)
    const failing = {
      record: vi.fn(async (): Promise<RecordResponse> => {
        throw new Error('down')
      }),
    }
    expect(await loadRecord(failing, 50)).toBeNull()
    const late = { record: vi.fn(() => new Promise<RecordResponse>(() => {})) }
    expect(await loadRecord(late, 20)).toBeNull()
  })
})

describe('last night names its winner markets (the 375 rail opens one on /verify)', () => {
  it('keeps each row’s winner market address', () => {
    const g = game({
      id: 'nba-401909318',
      status: 'final',
      home: 'OKC',
      away: 'MIN',
      homeScore: 106,
      awayScore: 113,
      period: 4,
      clockSecs: null,
      markets: [market({ pubkey: STORY, status: 'finalized', initialPriceBps: 7_181 })],
    })
    expect(nightRows([g]).rows[0]?.market).toBe(STORY)
  })
})

describe('/ wires the rail (§7 W6)', () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8')

  it('loads the counts beside the board, renders the rail under the hero, and passes `moved`', () => {
    const page = src('app/page.tsx')
    expect(page).toMatch(/Promise\.all\(\[[^\]]*initialRecord\(\)[^\]]*\]\)/)
    expect(page).toContain('moved={heroMoved(initial.games, initial.now)}')
    expect(page).toContain(
      '<ProofRail record={record} proofMarket={lastNight?.rows[0]?.market ?? null} />',
    )
    expect(page.indexOf('<Hero')).toBeLessThan(page.indexOf('<ProofRail'))
    expect(page.indexOf('<ProofRail')).toBeLessThan(page.indexOf('<TonightBoard'))
  })

  it('keeps the rail and the hero server components, so the program ids ship in HTML only', () => {
    for (const f of ['components/proof-rail.tsx', 'components/chrono/hero.tsx']) {
      expect(src(f), f).not.toMatch(/^['"]use client['"]/m)
    }
  })
})
