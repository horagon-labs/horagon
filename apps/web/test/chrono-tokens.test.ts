import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COLORS, type ColorToken, contrast, luminance } from '../lib/chrono/tokens'

const css = readFileSync(join(import.meta.dirname, '..', 'app', 'globals.css'), 'utf8')

/** Every pair the UI sets text in: [text, background] (spec 2.1, 2.6). */
const TEXT_PAIRS: [ColorToken, ColorToken][] = [
  ['ivory-100', 'enamel-950'],
  ['ivory-100', 'enamel-900'],
  ['ivory-100', 'enamel-800'],
  ['ash-400', 'enamel-950'],
  ['ash-400', 'enamel-900'],
  ['ash-400', 'enamel-800'],
  ['brass-500', 'enamel-900'],
  ['brass-400', 'enamel-900'],
  ['lume-300', 'enamel-900'],
  ['amber-400', 'enamel-900'],
  ['red-400', 'enamel-900'],
  ['enamel-950', 'lume-300'],
  ['enamel-950', 'brass-500'],
]

describe('Chronometer tokens (spec 2.1)', () => {
  it('computes WCAG luminance and contrast', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1, 6)
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 6)
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 6)
    expect(() => luminance('teal')).toThrow(/#rrggbb/)
  })

  it('keeps the weakest pair, ash-400 on enamel-900, at AA (4.5:1) or better', () => {
    expect(contrast(COLORS['ash-400'], COLORS['enamel-900'])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(TEXT_PAIRS)('%s text on %s passes AA', (text, bg) => {
    expect(contrast(COLORS[text], COLORS[bg])).toBeGreaterThanOrEqual(4.5)
  })

  it('matches the @theme block of app/globals.css', () => {
    for (const [name, hex] of Object.entries(COLORS)) {
      expect(css, name).toContain(`--color-${name}: ${hex};`)
    }
  })

  it('is dark only: no light color scheme', () => {
    expect(css).toContain('color-scheme: dark;')
    expect(css).not.toContain('light dark')
  })
})
