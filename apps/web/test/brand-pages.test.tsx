// Brand and pages in light (light branding review §4.10-§4.12, commit 6): one mark everywhere (white
// face, brass case, live needle, ink hub), the share card on paper inside a brass hairline, and
// light 404 and error pages that keep the play-money line, so no dark default page is left.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLAY_MONEY_NOTICE } from '@horagon/sdk/notice'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ErrorPage from '../app/error'
import GlobalError from '../app/global-error'
import NotFound from '../app/not-found'
import { DialMark, HomeIcon } from '../components/chrono/dial-mark'
import { Wordmark } from '../components/chrono/wordmark'
import { ShareCard, ShareGauge } from '../components/share-card'
import { COLORS } from '../lib/chrono/tokens'
import { ICON_COLORS } from '../lib/icons'
import { SOMETHING_WRONG } from '../lib/wallet-copy'

const noop = () => {}
const root = join(import.meta.dirname, '..')
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8')
const INK = COLORS['ivory-100']
const PAPER = COLORS['enamel-950']
const SHEET = COLORS['enamel-900']
const BRASS = COLORS['brass-700']

describe('the mark (review §4.10)', () => {
  it('gives every home-screen icon a white face, a brass case, a live needle and an ink hub', () => {
    expect(ICON_COLORS).toEqual({
      bg: PAPER,
      face: SHEET,
      ring: BRASS,
      needle: COLORS.live,
      hub: INK,
    })
  })

  it('draws the same mark as app/icon.svg: case 2.5 wide, hub its own colour', () => {
    const html = renderToStaticMarkup(
      <DialMark size={32} face={SHEET} ring={BRASS} needle={COLORS.live} hub={INK} />,
    )
    const icon = read('app', 'icon.svg')
    const caseTag = `fill="${SHEET}" stroke="${BRASS}" stroke-width="2.5"`
    expect(html).toContain(caseTag)
    expect(icon).toContain(caseTag)
    expect(html).toMatch(new RegExp(`r="2.5" fill="${INK}"`))
    expect(icon).toMatch(new RegExp(`r="2.5" fill="${INK}"`))
    const home = renderToStaticMarkup(<HomeIcon px={180} colors={ICON_COLORS} />)
    expect(home).toContain(`background:${PAPER}`)
    expect(home).toContain(caseTag)
    expect(home).toMatch(new RegExp(`r="2.5" fill="${INK}"`))
  })

  it('puts that mark before the ink wordmark in the header, with no currentColor left', () => {
    const html = renderToStaticMarkup(<Wordmark />)
    expect(html).toContain(`fill="${SHEET}" stroke="${BRASS}" stroke-width="2.5"`)
    expect(html).toMatch(new RegExp(`r="2.5" fill="${INK}"`))
    expect(html).not.toContain('currentColor')
    expect(html).toContain('text-brass-500') // ink by remap (chrono-shell keeps the class)
  })
})

describe('the share card (review §4.11)', () => {
  const card = (live?: boolean) =>
    renderToStaticMarkup(
      <ShareCard
        title="MEM @ CLE"
        line="MEM 78–84 CLE · Q3 4:12"
        headline="CLE to win · 77%"
        price={0.77}
        live={live}
      />,
    )

  it('sits on paper inside a 2 px brass hairline inset 20 px, not a 6 px border', () => {
    const html = card()
    expect(html).toMatch(new RegExp(`^<div style="[^"]*padding:20px;[^"]*background:${PAPER}`))
    expect(html).toMatch(new RegExp(`<div style="[^"]*border:2px solid ${BRASS}`))
    expect(html).not.toContain('6px solid')
  })

  it('names HORAGON in ink after the mark, and sets the headline in ink, open or stopped', () => {
    for (const live of [undefined, false]) {
      const html = card(live)
      expect(html).toMatch(new RegExp(`color:${INK}[^"]*"><svg[^>]*data-mark`))
      expect(html).toContain('>HORAGON</div>')
      const at = html.indexOf('CLE to win · 77%')
      expect(html.slice(html.lastIndexOf('<div', at), at)).toContain(`color:${INK}`)
    }
    // No ink-named old key left in the card: the codemod-safe spelling (review §8 risk 2).
    expect(read('components', 'share-card.tsx')).not.toMatch(
      /COLORS\['(?:lume-300|amber-400|brass-500|brass-400)'\]/,
    )
  })

  it('draws the gauge on a white face in a brass case, a rule-faint track, ink hub and pin', () => {
    const html = renderToStaticMarkup(<ShareGauge price={0.62} size={420} />)
    expect(html).toContain(`r="94" fill="${SHEET}" stroke="${BRASS}"`)
    expect(html).toMatch(new RegExp(`stroke="${COLORS['rule-faint']}" stroke-width="10"`))
    expect(html).toContain(`stroke="${COLORS['ash-400']}" stroke-width="2"`)
    expect(html).toContain(`r="8" fill="${INK}"`)
    expect(html).toContain(`r="3" fill="${SHEET}"`)
    expect(html).not.toContain(COLORS.line)
  })
})

describe('404 and error pages, light only (review §4.12)', () => {
  it('says Air ball on paper with the mark and a way back to tonight’s games', () => {
    const html = renderToStaticMarkup(<NotFound />)
    // The copy is culture A3's string 24 (R7); this test keeps it on paper with the mark.
    expect(html).toContain('Air ball. Nothing on the clock at this address.')
    expect(html).toContain('href="/"')
    expect(html).toContain("Back to tonight's games".replace("'", '&#x27;'))
    expect(html).toContain('data-mark')
    expect(html).not.toMatch(/dark|bg-black|bg-white/)
  })

  it('says SOMETHING_WRONG and offers to try again, never the error’s own words', () => {
    let tried = 0
    const html = renderToStaticMarkup(
      <ErrorPage error={new Error('secret stack')} retry={() => tried++} reset={noop} />,
    )
    expect(html).toContain(SOMETHING_WRONG)
    expect(html).toContain('>Try again</button>')
    expect(html).not.toContain('secret stack')
    expect(tried).toBe(0)
  })

  it('keeps the banner on both: the root layout draws it outside the error boundary', () => {
    expect(read('app', 'layout.tsx')).toMatch(/\{children\}<\/main>\s*<PlayMoneyBanner \/>/)
  })

  it('draws its own light document with the banner when the root layout itself failed', () => {
    const html = renderToStaticMarkup(
      <GlobalError error={new Error('secret stack')} retry={noop} reset={noop} />,
    )
    expect(html).toMatch(/^<html lang="en">(?:<head><\/head>)?<body class="/)
    const body = html.match(/<body class="([^"]*)"/)?.[1]?.split(' ') ?? []
    expect(body).toEqual(expect.arrayContaining(['bg-enamel-950', 'text-ivory-100', 'pb-14']))
    expect(html).toContain('role="note"')
    expect(html).toContain(PLAY_MONEY_NOTICE)
    expect(html).toContain(SOMETHING_WRONG)
    expect(html).not.toContain('secret stack')
    expect(read('app', 'global-error.tsx')).toContain("import './globals.css'")
  })

  it('makes the two error pages client components, as Next requires, and the 404 a server one', () => {
    expect(read('app', 'error.tsx')).toMatch(/^'use client'/)
    expect(read('app', 'global-error.tsx')).toMatch(/^'use client'/)
    expect(read('app', 'not-found.tsx')).not.toContain("'use client'")
  })
})
