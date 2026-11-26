// The play-money line has one look wherever it appears (u3 §4, light branding review §4.1): ink on
// a solid white band under a brass hairline, 13/600 on screen. The words never change.
import { PLAY_MONEY_NOTICE } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CrownSheet } from '../components/chrono/crown-sheet'
import { HERO_SUB, Hero } from '../components/chrono/hero'
import { PlayMoneyBanner } from '../components/play-money-banner'
import { ShareCard } from '../components/share-card'
import { COLORS, contrast } from '../lib/chrono/tokens'

const noop = () => {}

/** The class list of the element that holds `words` (the last opening tag before them). */
function classOf(html: string, words: string, tag = ''): string[] {
  const at = html.indexOf(words)
  expect(at, words).toBeGreaterThan(-1)
  const open = html.lastIndexOf(`<${tag}`, at)
  const cls = /class="([^"]*)"/.exec(html.slice(open, at))
  return cls?.[1]?.split(' ') ?? []
}

/** Calm: no caution or error hue, no alpha, no blink, no capitals. */
function expectCalm(cls: string[]) {
  for (const c of cls) {
    expect(c).not.toMatch(/amber|red-|lume|\/\d+$|animate-|uppercase/)
  }
}

describe('the play-money line (light branding review §4.1)', () => {
  it('is a solid white band at the foot of every page, brass hairline, ink 13/600', () => {
    const html = renderToStaticMarkup(<PlayMoneyBanner />)
    expect(html).toMatch(/^<div role="note"/)
    const cls = classOf(html, PLAY_MONEY_NOTICE)
    for (const c of [
      'fixed',
      'bottom-0',
      'z-20',
      'border-t',
      'border-brass-700',
      'bg-enamel-900',
      'text-13',
      'font-semibold',
      'text-ivory-100',
    ]) {
      expect(cls).toContain(c)
    }
    expectCalm(cls)
  })

  it('closes the crown sheet in the same look', () => {
    const html = renderToStaticMarkup(
      <CrownSheet open={false} onClose={noop} title="Buy CLE">
        <p>inside</p>
      </CrownSheet>,
    )
    const cls = classOf(html, PLAY_MONEY_NOTICE)
    for (const c of [
      'border-t',
      'border-brass-700',
      'text-13',
      'font-semibold',
      'text-ivory-100',
    ]) {
      expect(cls).toContain(c)
    }
    expect(cls).not.toContain('text-12')
    expectCalm(cls)
  })

  it('ends the share card in ink on a white strip under a 2 px brass hairline', () => {
    const html = renderToStaticMarkup(<ShareCard title="Horagon" line="x" price={null} />)
    const at = html.indexOf(PLAY_MONEY_NOTICE)
    const tag = html.slice(html.lastIndexOf('<div', at), at)
    expect(tag).toContain('font-size:24px')
    expect(tag).toContain('font-weight:600')
    expect(tag).toContain(`color:${COLORS['ivory-100']}`)
    expect(tag).toContain(`background:${COLORS['enamel-900']}`)
    expect(tag).toContain(`border-top:2px solid ${COLORS['brass-700']}`)
    expect(tag).not.toContain(COLORS.live)
  })

  it('leads the hero sub with a 14 px brass hairline, in ink 14/500', () => {
    const html = renderToStaticMarkup(<Hero />)
    const cls = classOf(html, HERO_SUB, 'p ')
    for (const c of ['text-14', 'font-medium', 'text-ivory-100']) {
      expect(cls).toContain(c)
    }
    expect(html).toMatch(
      new RegExp(
        `<span aria-hidden="true" class="[^"]*w-3\\.5[^"]*bg-brass-700[^"]*"></span>${HERO_SUB}</p>`,
      ),
    )
    expectCalm(cls)
  })

  it('reads at 17.6:1, and its hairline holds 3:1 against the page above it', () => {
    expect(contrast(COLORS['ivory-100'], COLORS['enamel-900'])).toBeCloseTo(17.6, 1)
    expect(contrast(COLORS['brass-700'], COLORS['enamel-950'])).toBeGreaterThanOrEqual(3)
  })
})
