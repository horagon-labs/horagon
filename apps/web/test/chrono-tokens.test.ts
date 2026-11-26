import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from '../app/manifest'
import { COLORS, type ColorToken, contrast, luminance } from '../lib/chrono/tokens'
import { deltaE2000, VISIONS, visionDelta } from './color-science'

const root = join(import.meta.dirname, '..')
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8')
const css = read('app', 'globals.css')

/**
 * Light only (light branding review §3.3, path A+): every old name keeps its utility and takes the
 * value of the role most of its uses play. Five old names land on ink.
 */
const LIGHT: Record<ColorToken, string> = {
  'enamel-950': '#f7f6f2', // surface: the page
  'enamel-900': '#ffffff', // surface-raised: a sheet to read on
  'enamel-800': '#eeece6', // surface-sunk: an empty slot, a pressed control
  line: '#84817a', // rule: a line that carries meaning
  'brass-700': '#8c7650', // brass: the watch's metal
  'brass-500': '#17191d', // ink
  'brass-400': '#17191d', // ink
  'lume-300': '#17191d', // ink
  'ivory-100': '#17191d', // ink
  'ash-400': '#58585a', // ink-muted: quiet or stopped
  'amber-400': '#17191d', // ink
  'red-400': '#b3261e', // error
  live: '#0b5fa5', // the market is open, and your ◆
  'rule-faint': '#dad7cf', // structure that carries no data
}

/** The semantic names (§3.1), aliases of the old names until the codemod (j-build G1). */
const ALIASES: Record<string, ColorToken> = {
  surface: 'enamel-950',
  'surface-raised': 'enamel-900',
  'surface-sunk': 'enamel-800',
  ink: 'ivory-100',
  'ink-muted': 'ash-400',
  rule: 'line',
  brass: 'brass-700',
  error: 'red-400',
}

/** Every pair the UI sets text in, [text, background], with its id in review §3.4. */
const TEXT_PAIRS: [string, ColorToken, ColorToken][] = [
  ['B1 ink on the page', 'ivory-100', 'enamel-950'],
  ['B2 ink on a sheet', 'ivory-100', 'enamel-900'],
  ['B3 ink on a slot', 'ivory-100', 'enamel-800'],
  ['B4 muted on the page', 'ash-400', 'enamel-950'],
  ['B5 muted on a sheet', 'ash-400', 'enamel-900'],
  ['B6 muted on a slot', 'ash-400', 'enamel-800'],
  ['B7 error on the page', 'red-400', 'enamel-950'],
  ['B8 error on a sheet', 'red-400', 'enamel-900'],
  ['B9 paper label on an ink button', 'enamel-950', 'ivory-100'],
  ['B9 paper label on a lume-named button', 'enamel-950', 'lume-300'],
  ['B9 paper label on a brass-named button', 'enamel-950', 'brass-500'],
  ['B12 Tape last-price pill', 'enamel-900', 'live'],
  ['B13 Tape "Market" legend', 'live', 'enamel-950'],
  ['B14 Tape crosshair label', 'enamel-900', 'ivory-100'],
  ['ink-named words on a sheet: brass-500', 'brass-500', 'enamel-900'],
  ['ink-named words on a sheet: brass-400', 'brass-400', 'enamel-900'],
  ['ink-named words on a sheet: lume-300', 'lume-300', 'enamel-900'],
  ['ink-named words on a sheet: amber-400', 'amber-400', 'enamel-900'],
  ['ink-named words on the page: lume-300', 'lume-300', 'enamel-950'],
  ['ink-named words on a slot: lume-300', 'lume-300', 'enamel-800'],
]

/** Live numbers are set in ink (u3 §3.2) and hold 7:1 or better: L1-L3. */
const NUMBER_PAIRS: [ColorToken, ColorToken][] = [
  ['ivory-100', 'enamel-900'],
  ['ivory-100', 'enamel-950'],
  ['ivory-100', 'enamel-800'],
  ['lume-300', 'enamel-950'],
]

/** Graphics that carry meaning hold 3:1 against what is next to them (§3.4 U1-U15). */
const UI_PAIRS: [string, ColorToken, ColorToken][] = [
  ['U1 needle, live ring on a face', 'live', 'enamel-900'],
  ['U2 live ring against its track', 'live', 'rule-faint'],
  ['U3 your ◆ on the page', 'live', 'enamel-950'],
  ['U4 model ▲, hub, halted hatch', 'ivory-100', 'enamel-900'],
  ['U5 halted hatch against its track', 'ivory-100', 'rule-faint'],
  ['U6 stopped needle, ticks', 'ash-400', 'enamel-900'],
  ['U7 proposed ring against its track', 'ash-400', 'rule-faint'],
  ['U8 challenged rim, stale mark', 'red-400', 'enamel-900'],
  ['U9 challenged ring against its track', 'red-400', 'rule-faint'],
  ['U10 control edge on a sheet', 'line', 'enamel-900'],
  ['U11 game row edge on the page', 'line', 'enamel-950'],
  ['U12 brass case on a face', 'brass-700', 'enamel-900'],
  ['U13 banner hairline against the page', 'brass-700', 'enamel-950'],
  ['U14 buzzer index across the track', 'brass-700', 'rule-faint'],
  ['U15 focus on the page', 'ivory-100', 'enamel-950'],
  ['U15 focus on a slot', 'ivory-100', 'enamel-800'],
]

/** Alpha over a background, blended in gamma sRGB as browsers do. */
function over(fg: string, alpha: number, bg: string): string {
  const ch = (hex: string, i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  return `#${[0, 1, 2]
    .map((i) => Math.round(ch(fg, i) * alpha + ch(bg, i) * (1 - alpha)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * Colors that meet on one element and must stay apart for every viewer (u3 §3.3): CIEDE2000 of 20
 * or more with normal vision and 10 or more with each colour-vision deficiency. Live and closing
 * share the live color on purpose; width, the blinking tick and "closes in" tell them apart.
 */
const VISION_PAIRS: [string, ColorToken, ColorToken][] = [
  ['live needle ~ model ▲', 'live', 'ivory-100'],
  ['live needle ~ stopped needle', 'live', 'ash-400'],
  ['live ring ~ challenged ring', 'live', 'red-400'],
  ['halted hatch ~ challenged ring', 'amber-400', 'red-400'],
  ['model ~ error', 'brass-500', 'red-400'],
  ['Tape market line ~ model line', 'live', 'brass-500'],
  ['your ◆ ~ model ▲', 'live', 'brass-500'],
  ['run marker ~ model', 'ash-400', 'brass-500'],
  ['event beat ~ your ◆', 'amber-400', 'live'],
  ['focus ~ your ◆', 'ivory-100', 'live'],
  ['pending ghost ~ priced ghost', 'line', 'live'],
  ['brass case ~ error rim', 'brass-700', 'red-400'],
  ['brass ~ live', 'brass-700', 'live'],
  ['brass ~ ink-muted', 'brass-700', 'ash-400'],
  ['ink-muted ~ error', 'ash-400', 'red-400'],
]

const SOURCES = ['app', 'components', 'lib'].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(tsx?|css)$/.test(file))
    .map((file) => join(dir, file)),
)

const OLD_NAMES =
  'enamel-950|enamel-900|enamel-800|line|brass-700|brass-500|brass-400|lume-300|ivory-100|ash-400|amber-400|red-400'
const OLD_UTILITY = new RegExp(
  `(?<![\\w-])(?:bg|text|border(?:-[trblxy])?|stroke|fill|accent|outline|ring|decoration|divide|caret|placeholder)-(?:${OLD_NAMES})(?![\\w-])`,
  'g',
)
const OLD_COLORS_KEY = new RegExp(`COLORS(?:\\['(?:${OLD_NAMES})'\\]|\\.line\\b)`, 'g')

/**
 * The ratchet (j-build G1): the old names lie (`text-lume-300` paints ink), so their count may only
 * fall. Lower these when a line moves to a semantic name; raise one only for a line the light
 * branding review's Phase 1 asks for by its old name, and say so in the commit.
 */
const OLD_UTILITY_CEILING = 233
const OLD_COLORS_KEY_CEILING = 36

describe('Chronometer tokens (spec 2.1, light branding review §3)', () => {
  it('computes WCAG luminance and contrast', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1, 6)
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 6)
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 6)
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(() => luminance('teal')).toThrow(/#rrggbb/)
  })

  it('computes CIEDE2000 to four places (Sharma, Wu and Dalal 2005)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4)
    expect(deltaE2000([50, -1, 2], [50, 0, 0])).toBeCloseTo(2.3669, 4)
    expect(deltaE2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(
      1.2644,
      4,
    )
    expect(deltaE2000([2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514])).toBeCloseTo(0.9082, 4)
  })

  it('takes the light values by role, the old names kept (path A+)', () => {
    expect(COLORS).toEqual(LIGHT)
  })

  it('matches the @theme block of app/globals.css', () => {
    for (const [name, hex] of Object.entries(COLORS)) {
      expect(css, name).toContain(`--color-${name}: ${hex};`)
    }
  })

  it('names every role: the semantic aliases point at the old names', () => {
    for (const [role, old] of Object.entries(ALIASES)) {
      expect(css, role).toContain(`--color-${role}: var(--color-${old});`)
    }
    expect(css).toContain('background-color: var(--color-surface);')
    expect(css).toContain('color: var(--color-ink);')
    expect(css).toContain('outline: 2px solid var(--color-ink);')
  })

  it('keeps the weakest text pair, ink-muted on a slot, at 6:1 (B6)', () => {
    expect(contrast(COLORS['ash-400'], COLORS['enamel-800'])).toBeCloseTo(6.01, 2)
  })

  it.each(TEXT_PAIRS)('%s passes AA (4.5:1)', (_, text, bg) => {
    expect(contrast(COLORS[text], COLORS[bg])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(NUMBER_PAIRS)('live numbers in %s on %s hold 7:1', (text, bg) => {
    expect(contrast(COLORS[text], COLORS[bg])).toBeGreaterThanOrEqual(7)
  })

  it.each(UI_PAIRS)('%s holds 3:1', (_, fg, bg) => {
    expect(contrast(COLORS[fg], COLORS[bg])).toBeGreaterThanOrEqual(3)
  })

  it('keeps the banner legible under the 30 % ink scrim (B11)', () => {
    const banner = over(COLORS['ivory-100'], 0.3, COLORS['enamel-900'])
    expect(banner).toBe('#b9babb')
    expect(contrast(COLORS['ivory-100'], banner)).toBeCloseTo(9.05, 2)
  })

  it('pins the thin pairs so a token change cannot slip under them (§8 risk 6)', () => {
    expect(contrast(COLORS['brass-700'], COLORS['rule-faint'])).toBeCloseTo(3.03, 2)
    expect(contrast(COLORS.line, COLORS['enamel-800'])).toBeCloseTo(3.29, 2)
    expect(visionDelta(COLORS['brass-700'], COLORS['red-400'], 'deutan')).toBeCloseTo(10.9, 1)
  })

  it.each(VISION_PAIRS)('%s stays apart for every vision (u3 §3.3)', (_, a, b) => {
    for (const vision of VISIONS) {
      const floor = vision === 'normal' ? 20 : 10
      expect(visionDelta(COLORS[a], COLORS[b], vision), vision).toBeGreaterThanOrEqual(floor)
    }
  })

  it('reproduces the review numbers for live against ink (§3.5)', () => {
    const d = VISIONS.map((v) => visionDelta(COLORS.live, COLORS['ivory-100'], v))
    expect(d.map((x) => x.toFixed(1))).toEqual(['29.7', '31.3', '29.0', '30.5'])
  })

  it('is light only: no scheme switch, no dark path left', () => {
    expect(css).toContain('color-scheme: only light;')
    expect(css).not.toMatch(/\bdark\b/)
    const layout = read('app', 'layout.tsx')
    expect(layout).toContain("colorScheme: 'only light'")
    expect(layout).toContain("themeColor: COLORS['enamel-900']")
    const m = manifest()
    expect(m.background_color).toBe('#f7f6f2')
    expect(m.theme_color).toBe('#ffffff')
    for (const file of SOURCES) {
      const text = read(file)
      expect(text, file).not.toMatch(/\bdark:|prefers-color-scheme|bg-black|bg-white/)
      expect(text, file).not.toMatch(/#07090b|#0d1014|#11151a|#151a20|radialGradient/i)
    }
  })

  it('draws the favicon on a white face: brass case, live needle, ink hub (§4.10)', () => {
    const icon = read('app', 'icon.svg')
    expect(icon).toContain(`fill="${COLORS['enamel-900']}" stroke="${COLORS['brass-700']}"`)
    expect(icon).toContain(`stroke="${COLORS.live}"`)
    expect(icon).toContain(`fill="${COLORS['ivory-100']}"`)
  })

  it('lets the old names only shrink (ratchet, j-build G1)', () => {
    let utilities = 0
    let keys = 0
    for (const file of SOURCES) {
      if (file.endsWith('globals.css') || file.endsWith('tokens.ts')) continue
      const text = read(file)
      utilities += text.match(OLD_UTILITY)?.length ?? 0
      keys += text.match(OLD_COLORS_KEY)?.length ?? 0
    }
    expect(utilities).toBeLessThanOrEqual(OLD_UTILITY_CEILING)
    expect(keys).toBeLessThanOrEqual(OLD_COLORS_KEY_CEILING)
  })
})
