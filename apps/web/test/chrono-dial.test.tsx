import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Dial, type DialProps } from '../components/chrono/dial'
import { isBeat, priceDigits, ringClass, stateLine } from '../components/chrono/dial-look'
import { MiniDial } from '../components/chrono/mini-dial'
import { at, game, NOW } from '../lib/chrono/fixtures'
import { DIAL_STATES } from '../lib/chrono/state'

const BASE: DialProps = {
  price: 0.77,
  modelProb: 0.74,
  timeLeft: 0.5,
  state: 'live',
  label: 'CLE to win, 77%, model 74%, open until the final buzzer',
  caption: 'CLE to win',
}

const dial = (over: Partial<DialProps> = {}) => renderToStaticMarkup(<Dial {...BASE} {...over} />)

/** The transform of the needle of one kind, or undefined when that needle is not drawn. */
const needle = (html: string, kind: 'price' | 'ghost' = 'price') =>
  html.match(new RegExp(`<g transform="([^"]+)"[^>]*data-needle="${kind}"`))?.[1]

describe('Dial (spec 3.2, 4.3)', () => {
  it('points the needle at the price and reads the whole sentence', () => {
    const html = dial()
    expect(needle(html)).toBe('rotate(72.9 100 100)')
    expect(html).toContain('role="img"')
    expect(html).toContain(`aria-label="${BASE.label}"`)
    expect(html).toContain('data-value="77"')
    expect(html).toMatch(/data-caption="true">CLE to win<\/span>/)
    expect(html).toContain('<span class="text-19">%</span>')
  })

  it('greys the number once trading stopped, and says the final in the caption (R5)', () => {
    expect(dial()).toContain('font-mono tabular-nums text-ivory-100')
    const html = dial({ state: 'closed', caption: 'Final · CLE lost · result pending' })
    expect(html).toContain('font-mono tabular-nums text-ash-400')
    expect(html).toContain('Final · CLE lost · result pending')
    expect(html).not.toContain('wins')
  })

  it('keeps the 0 and 100 numerals out of the needle sweep and below the words (merge verify)', () => {
    const html = dial({ price: 1, state: 'resolved', caption: 'Resolved: DAL won' })
    const at = (n: string) => {
      const m = html.match(new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)"[^>]*>${n}</text>`))
      if (!m) throw new Error(`no ${n} numeral`)
      const [x, y] = [Number(m[1]), Number(m[2])]
      return { angle: (Math.atan2(x - 100, 100 - y) * 180) / Math.PI, y }
    }
    for (const n of ['0', '100']) {
      // The needle sweeps -135..135 degrees: a numeral past either end is never under it.
      expect(Math.abs(at(n).angle), n).toBeGreaterThan(135)
      // Below the number, caption and detail: in the light layout 0 and 100 sit at r70 ±142°
      // (y ≈ 155), under the one-line caption band that ends above y ≈ 150 (review §4.2).
      expect(at(n).y, n).toBeGreaterThanOrEqual(150)
    }
    expect(Math.abs(at('50').angle)).toBeLessThan(1)
  })

  it('draws the caption and the detail on a paper box, so a needle passes under the words', () => {
    const html = dial({ caption: 'CLE to win', detail: 'Open until the final buzzer' })
    expect(html).toMatch(/<span class="[^"]*bg-surface-raised[^"]*" data-caption="true">/)
    expect(html).toMatch(
      /<span class="[^"]*bg-surface-raised[^"]*">Open until the final buzzer<\/span>/,
    )
    // Light only (review §10 D9): no dark backdrop behind the words.
    expect(html).not.toContain('bg-enamel-900')
  })

  it('shows only the caption once resolved: no number beside "Resolved: MEM won"', () => {
    const html = dial({ state: 'resolved', price: 0, caption: 'Resolved: MEM won' })
    expect(html).not.toContain('data-value')
    expect(html).not.toContain('<span class="text-19">%</span>')
    expect(html).toMatch(/data-caption="true">Resolved: MEM won<\/span>/)
    expect(needle(html)).toBe('rotate(-135 100 100)')
  })

  it('draws no needle and an em dash for a null price, never NaN (Review Focus 1)', () => {
    const html = dial({ price: null, ghostPrice: 0.8 })
    expect(needle(html)).toBeUndefined()
    expect(needle(html, 'ghost')).toBeUndefined()
    expect(html).toContain('data-value="—"')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('data-impact')
  })

  it('holds a neutral frame while loading: no needle at 50, no number (R5)', () => {
    const html = dial({ loading: true, price: null, ghostPrice: 0.8, caption: undefined })
    expect(needle(html)).toBeUndefined()
    expect(needle(html, 'ghost')).toBeUndefined()
    expect(html).toContain('data-skeleton')
    expect(html).not.toContain('data-value')
  })

  it('carries a class and a ring color for every DialState', () => {
    for (const state of DIAL_STATES) {
      const html = dial({ state })
      expect(html, state).toContain(`dial dial-${state} `)
      expect(html, state).toContain(`data-state="${state}"`)
      // A price on the face: `pre` is an open market before tip-off (ringClass).
      expect(html, state).toMatch(new RegExp(`class="${ringClass(state, true)}" data-ring`))
    }
    expect(dial({ state: 'pre', price: null })).toMatch(/class="stroke-ash-400" data-ring/)
  })

  it('hides the needle of a void game even with a price', () => {
    const html = dial({ state: 'void' })
    expect(needle(html)).toBeUndefined()
    expect(html).toContain('data-value="—"')
  })

  it('hatches the ring when halted, reddens the rim when challenged, blinks when closing', () => {
    expect(dial({ state: 'halted' })).toContain('stroke-dasharray="3 3"')
    expect(dial({ state: 'challenged' })).toMatch(/class="stroke-red-400" data-rim/)
    expect(dial({ state: 'closing' })).toContain('stroke-ash-400 animate-blink')
    expect(dial({ state: 'live' })).not.toContain('animate-blink')
  })

  it('dashes the needle of a proposal (no fading) and keeps its angle', () => {
    const html = dial({ state: 'proposed', price: 1 })
    expect(needle(html)).toBe('rotate(135 100 100)')
    expect(html).toMatch(
      /class="stroke-ash-400" data-needle="price"><line [^>]*stroke-dasharray="6 4"/,
    )
    expect(html).not.toContain('opacity-')
  })

  it('draws the ghost needle and the impact arc between the two prices (spec 5.5)', () => {
    const html = dial({ ghostPrice: 0.8 })
    expect(needle(html, 'ghost')).toBe('rotate(81 100 100)')
    expect(html).toContain('data-impact')
    expect(dial({ ghostPrice: 0.8, ghostPending: true })).toMatch(
      /class="stroke-line" data-needle="ghost"/,
    )
    expect(dial({ ghostPrice: 0.8, ghostShake: true })).toContain('animate-shake')
  })

  it('marks the model, the stale bezel and the live dot', () => {
    expect(dial()).toContain('data-model="74"')
    expect(dial({ modelProb: null })).not.toContain('data-model')
    expect(dial({ stale: true })).toContain('data-stale')
    expect(dial()).not.toContain('data-stale')
    expect(dial({ liveDot: true })).toContain('data-live')
  })

  it('plays no beat on the first render', () => {
    const html = dial({ state: 'resolved', price: 1, runKey: 'run-1' })
    expect(html).not.toContain('data-beat')
  })

  it('plays a beat only for a new event on a dial that already had data (spec 2.4)', () => {
    expect(isBeat({ key: undefined, armed: false }, 'run-1')).toBe(false)
    expect(isBeat({ key: null, armed: false }, 'resolved')).toBe(false)
    expect(isBeat({ key: null, armed: true }, 'run-1')).toBe(true)
    expect(isBeat({ key: null, armed: true }, 'resolved')).toBe(true)
    expect(isBeat({ key: 'run-1', armed: true }, 'run-1')).toBe(false)
    expect(isBeat({ key: 'run-1', armed: true }, null)).toBe(false)
  })
})

describe('MiniDial (spec 3.2)', () => {
  const mini = (over: Partial<Parameters<typeof MiniDial>[0]> = {}) =>
    renderToStaticMarkup(<MiniDial price={0.77} timeLeft={0.5} state="live" {...over} />)

  it('is a hidden 100-unit picture with a needle about its own center', () => {
    const html = mini()
    expect(html).toContain('viewBox="0 0 100 100"')
    expect(html).toContain('aria-hidden="true"')
    expect(needle(html)).toBe('rotate(72.9 50 50)')
    expect(html).not.toContain('data-value')
  })

  it('draws no needle for a null price, never NaN (Review Focus 1)', () => {
    const html = mini({ price: null })
    expect(needle(html)).toBeUndefined()
    expect(html).not.toContain('NaN')
  })

  it('keeps one rim whatever you hold: yours is the row’s ◆ (review §4.3)', () => {
    expect(mini()).toMatch(/fill-enamel-900 stroke-brass-700" data-rim/)
    expect(mini()).not.toContain('lume')
  })
})

describe('dial words', () => {
  const live = game()

  it('shows whole cents or an em dash', () => {
    expect(priceDigits(0.77)).toBe('77')
    expect(priceDigits(0.996)).toBe('>99')
    expect(priceDigits(null)).toBe('—')
    expect(priceDigits(Number.NaN)).toBe('—')
  })

  it('says one line per state, with the copy the app already uses', () => {
    expect(stateLine('closing', live, 252, NOW)).toBe('closes in 4:12')
    expect(stateLine('live', live, 3730, NOW)).toBe('Open until the final buzzer')
    expect(stateLine('closed', live, 0, NOW)).toBe('Trading closed · result pending')
    expect(stateLine('challenged', live, 0, NOW)).toBe('Result under review')
    expect(stateLine('halted', live, 900, NOW)).toBe('Trading halted')
    expect(stateLine('void', game({ status: 'postponed' }), null, NOW)).toBe('Postponed')
    const later = game({ status: 'scheduled', scheduledTipoff: '2026-11-25T03:30:00Z' })
    expect(stateLine('pre', later, null, NOW)).toBe('Opens 60 min before tip-off')
    // A game that started with no market will not get one (R5c, review finding 5).
    expect(stateLine('pre', live, null, NOW)).toBe('No market for this game')
    expect(stateLine('pre', game({ status: 'final' }), null, NOW)).toBe('No market for this game')
    expect(stateLine('pre', later, 9000, NOW)).toBe('tip-off in 1:22:00')
    expect(stateLine('pre', later, 9000, at('2026-11-25T03:31:00Z'))).toBe('tip-off soon')
  })
})
