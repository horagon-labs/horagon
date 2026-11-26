// The instruments in light (light branding review §4.2-§4.7, commit 4): one flat white face in a
// brass case, structure in rule-faint, no opacity anywhere (each state is a hue, a width or a dash
// that holds its contrast), the model ▲ clear of the ring, the state line under the face.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Dial, type DialProps } from '../components/chrono/dial'
import { RING, rimClass, ringDash, ringShare } from '../components/chrono/dial-look'
import { Gallery } from '../components/chrono/gallery'
import { GameScreen, NoGame } from '../components/chrono/game-screen'
import { MiniDial } from '../components/chrono/mini-dial'
import { NightDial } from '../components/chrono/night-dial'
import { Scorebug } from '../components/chrono/scorebug'
import { boardItem } from '../lib/chrono/board'
import { detail, evening, game, history, market, NOW } from '../lib/chrono/fixtures'
import { gameDial } from '../lib/chrono/game'
import { priceToAngle } from '../lib/chrono/geometry'
import { findRuns } from '../lib/chrono/runs'
import { DIAL_STATES } from '../lib/chrono/state'
import { runMarkers, TAPE_FRAME } from '../lib/chrono/tape'
import { COLORS } from '../lib/chrono/tokens'

const BASE: DialProps = {
  price: 0.77,
  modelProb: 0.74,
  timeLeft: 0.5,
  state: 'live',
  label: 'CLE to win, 77%',
  caption: 'CLE to win',
}
const dial = (over: Partial<DialProps> = {}) => renderToStaticMarkup(<Dial {...BASE} {...over} />)
const tag = (html: string, attr: string) =>
  html.match(new RegExp(`<[a-z]+ [^>]*${attr}[^>]*>`))?.[0]
const num = (t: string | undefined, a: string) =>
  Number(t?.match(new RegExp(` ${a}="([^"]+)"`))?.[1])
const classAt = (html: string, marker: string) => {
  const at = html.indexOf(marker)
  const open = html.lastIndexOf('<', at)
  return html.slice(open, html.indexOf('>', at) + 1).match(/class="([^"]*)"/)?.[1] ?? ''
}
const dist = (x: number, y: number, c = 100) => Math.hypot(x - c, y - c)
/** Clockwise from 12 o'clock, in degrees, -180..180. */
const angleOf = (x: number, y: number, c = 100) => (Math.atan2(x - c, c - y) * 180) / Math.PI

describe('Dial face and case (review §4.2)', () => {
  it('puts a brass case of 1.5 around the face, and a 2 px error rim instead while challenged', () => {
    expect(rimClass('live')).toBe('stroke-brass-700')
    expect(tag(dial(), 'data-rim')).toMatch(/stroke-width="1.5" class="stroke-brass-700"/)
    expect(tag(dial({ state: 'challenged' }), 'data-rim')).toMatch(
      /stroke-width="2" class="stroke-red-400"/,
    )
  })

  it('draws the inner ring and the empty time track in rule-faint', () => {
    const html = dial()
    expect(html).toMatch(/r="93" fill="none" stroke-width="0.75" class="stroke-rule-faint"/)
    expect(html).toMatch(/r="89" fill="none" stroke-width="3" class="stroke-rule-faint"/)
    expect(html).not.toContain('stroke-brass-700"/><circle cx="100" cy="100" r="89"')
  })

  it('widens the ring while closing (4.5 against 3), and keeps its hue', () => {
    expect(tag(dial({ state: 'closing' }), 'data-ring')).toMatch(/stroke-width="4.5"/)
    expect(tag(dial({ state: 'closing' }), 'data-ring')).toContain('class="stroke-live"')
    for (const state of DIAL_STATES.filter((s) => s !== 'closing')) {
      expect(tag(dial({ state }), 'data-ring'), state).toMatch(/stroke-width="3"/)
    }
  })

  it('dots a proposed ring in ink-muted, and draws void in the plain rule', () => {
    expect(RING.proposed).toBe('stroke-ash-400')
    expect(ringDash('proposed')).toBe('1.5 3')
    expect(ringDash('halted')).toBe('3 3')
    expect(RING.void).toBe('stroke-line')
    // A proposed result and one under review are statuses, drawn whole like a halt.
    for (const s of ['halted', 'proposed', 'challenged'] as const)
      expect(ringShare(s, 0), s).toBe(1)
    expect(ringShare('closed', 0)).toBe(0)
    expect(tag(dial({ state: 'proposed' }), 'data-ring')).toMatch(
      /stroke-dasharray="1.5 3" class="stroke-ash-400"/,
    )
  })

  it('dashes a proposed needle instead of fading it, and never fades anything', () => {
    const html = dial({ state: 'proposed', price: 1 })
    expect(html).toMatch(
      /class="stroke-ash-400" data-needle="price"><line [^>]*stroke-dasharray="6 4"/,
    )
    for (const state of DIAL_STATES) {
      expect(dial({ state, ghostPrice: 0.8 }), state).not.toMatch(/opacity-\d/)
      expect(dial({ state, ghostPrice: 0.8, ghostPending: true }), state).not.toMatch(/opacity-\d/)
    }
    expect(dial({ state: 'live' })).not.toContain('stroke-dasharray="6 4"')
  })

  it('draws the impact arc as a plain rule, with no alpha', () => {
    expect(tag(dial({ ghostPrice: 0.8 }), 'data-impact')).toContain('class="stroke-line"')
  })

  it('sets the ▲ inside the ring: base at r86 ±3.8°, tip at r78.5', () => {
    const points = (tag(dial(), 'data-model')?.match(/points="([^"]+)"/)?.[1] ?? '')
      .split(' ')
      .map((p) => p.split(',').map(Number) as [number, number])
    const a = priceToAngle(0.74)
    expect(points).toHaveLength(3)
    const [b1, b2, tip] = points as [[number, number], [number, number], [number, number]]
    expect(dist(...b1)).toBeCloseTo(86, 2)
    expect(dist(...b2)).toBeCloseTo(86, 2)
    expect(angleOf(...b1)).toBeCloseTo(a - 3.8, 1)
    expect(angleOf(...b2)).toBeCloseTo(a + 3.8, 1)
    expect(dist(...tip)).toBeCloseTo(78.5, 2)
    // The ring's inner edge is 87.5: the base clears it by 1.5.
    expect(87.5 - 86).toBe(1.5)
  })

  it('ends the needle tail at r8, and caps the ink hub with a paper pin', () => {
    const line = dial().match(/data-needle="price"><line ([^>]+)>/)?.[1] ?? ''
    expect(num(` ${line}`, 'y1')).toBe(108)
    expect(dial()).toMatch(/<circle cx="100" cy="100" r="5" class="fill-brass-500"/)
    expect(dial()).toMatch(/<circle cx="100" cy="100" r="1.6" class="fill-enamel-900"/)
  })

  it('sets 0 and 100 at r70 ±142°, and 50 at r69, clear of the caption', () => {
    const html = dial()
    const at = (label: string) => {
      const t = html.match(new RegExp(`<text x="([^"]+)" y="([^"]+)"[^>]*>${label}</text>`))
      return [Number(t?.[1]), Number(t?.[2])] as [number, number]
    }
    expect(dist(...at('0'))).toBeCloseTo(70, 2)
    expect(angleOf(...at('0'))).toBeCloseTo(-142, 1)
    expect(dist(...at('100'))).toBeCloseTo(70, 2)
    expect(angleOf(...at('100'))).toBeCloseTo(142, 1)
    expect(dist(...at('50'))).toBeCloseTo(69, 2)
    expect(angleOf(...at('50'))).toBeCloseTo(0, 1)
  })

  it('keeps the longest caption on one line on a phone-width face, clear of 0 and 100 (§8 risk 3)', () => {
    // "Final · CLE lost · result pending" wrapped at 70 % on a 343 px face (375 px phone) and its
    // second line sat between 0 and 100. 80 % holds it on one line from a 336 px face up; below
    // that (a 320 px phone) the face is a container narrow enough to drop the caption's tracking.
    const html = dial({ state: 'closed', caption: 'Final · CLE lost · result pending' })
    expect(html.match(/<div role="img"[^>]*class="([^"]+)"/)?.[1]).toContain('@container')
    const caption = classAt(html, 'data-caption')
    expect(caption).toContain('max-w-[80%]')
    expect(caption).toContain('tracking-[0.16em]')
    expect(caption).toContain('@max-[21rem]:tracking-normal')
    expect(caption).not.toContain('max-w-[70%]')
    // ...and a narrow face also sets the number at 36 and lifts the block a little.
    expect(html).toContain(
      'leading-none font-mono text-40 tabular-nums @max-[21rem]:text-[2.25rem]',
    )
    expect(html).toMatch(/top-\[54%\][^"]*@max-\[21rem\]:top-\[53%\] @max-\[21rem\]:gap-0.5/)
  })

  it('holds the loading frame on a sunk slot, not a translucent rule', () => {
    const html = dial({ loading: true, price: null, caption: undefined })
    expect(html).toMatch(/bg-enamel-800" data-skeleton/)
    expect(html).not.toContain('bg-line/')
  })
})

describe('the state line sits under the face (review §4.2)', () => {
  it('writes it below the dial on the game screen, in 13 px ink-muted, not inside the face', () => {
    const html = renderToStaticMarkup(
      <GameScreen
        game={detail()}
        history={history()}
        dial={gameDial(game(), market(), NOW - 3_730, null, NOW)}
        now={NOW}
        stale={false}
        right={null}
      />,
    )
    const face = html.slice(html.indexOf('role="img"'), html.indexOf('data-state-line'))
    expect(html).toContain(
      '<p class="mt-2 text-center text-13 text-ash-400" data-state-line="true">Open until the final buzzer</p>',
    )
    expect(face).not.toContain('Open until the final buzzer</span>')
  })

  it('does the same on the still face and in the gallery', () => {
    expect(renderToStaticMarkup(<NoGame />)).toContain(
      '<p class="mt-2 text-center text-13 text-ash-400" data-state-line="true">No game here</p>',
    )
    const gallery = renderToStaticMarkup(<Gallery />)
    expect(gallery).toContain('data-state-line="true">closes in 4:12</p>')
  })

  it('makes the crown nub brass metal, like the case (review §4.5)', () => {
    expect(renderToStaticMarkup(<Gallery />)).toMatch(/class="fill-brass-700" data-crown/)
  })
})

describe('MiniDial in light (review §4.3)', () => {
  const mini = (over: Partial<Parameters<typeof MiniDial>[0]> = {}) =>
    renderToStaticMarkup(<MiniDial price={0.77} timeLeft={0.5} state="live" {...over} />)

  it('has a white face in a brass case, a rule-faint track and an ink hub with a pin', () => {
    expect(mini()).toMatch(/stroke-width="1.5" class="fill-enamel-900 stroke-brass-700" data-rim/)
    expect(mini({ state: 'challenged' })).toMatch(
      /stroke-width="2" class="fill-enamel-900 stroke-red-400" data-rim/,
    )
    expect(mini()).toMatch(/r="42" fill="none" stroke-width="4" class="stroke-rule-faint"/)
    expect(mini()).toMatch(/r="4" class="fill-brass-500"/)
    expect(mini()).toMatch(/r="1.3" class="fill-enamel-900"/)
  })

  it('widens the ring while closing (6 against 4)', () => {
    expect(tag(mini({ state: 'closing' }), 'data-ring')).toMatch(/stroke-width="6"/)
    expect(tag(mini(), 'data-ring')).toMatch(/stroke-width="4"/)
  })
})

describe('Night dial in light (review §4.4)', () => {
  const night = (items = evening().map((g) => boardItem(g, undefined, NOW))) =>
    renderToStaticMarkup(
      <NightDial items={items} now={NOW} selectedId={null} onSelect={() => {}} emptyText="" />,
    )
  const arcs = (html: string) =>
    (html.match(/<path [^>]*pointer-events="none"[^>]*>/g) ?? []) as string[]

  it('has a white face in a brass case, and a rule-faint hub', () => {
    expect(night()).toMatch(/r="97" stroke-width="1.5" class="fill-enamel-900 stroke-brass-700"/)
    expect(tag(night(), 'data-hub')).toContain('class="stroke-rule-faint"')
  })

  it('thins the past to 1.5 instead of fading it, and widens a closing arc to 4.5', () => {
    const html = night()
    expect(html).not.toMatch(/opacity-\d/)
    const widths = arcs(html).map((t) => num(t, 'stroke-width'))
    expect(widths).toContain(1.5)
    expect(widths).toContain(3.5)
    expect(widths).toContain(4.5)
    // BOS @ MIL closes in 130 s: its open segment is the 4.5 one.
    const closing = arcs(html).filter((t) => t.includes('stroke-width="4.5"'))
    for (const t of closing) expect(t).toContain('class="stroke-live"')
  })

  it('lights the hovered arc by 1.5 more', () => {
    const items = evening().map((g) => boardItem(g, undefined, NOW))
    const lit = renderToStaticMarkup(
      <NightDial
        items={items}
        now={NOW}
        selectedId={null}
        hoverId="nba-401810002"
        onSelect={() => {}}
        emptyText=""
      />,
    )
    const widths = arcs(lit).map((t) => num(t, 'stroke-width'))
    expect(widths).toContain(5)
    expect(widths).toContain(3)
  })

  it('hatches a halt in ink, 3 3', () => {
    const halted = boardItem(game({ markets: [market({ status: 'halted' })] }), undefined, NOW)
    expect(halted.state).toBe('halted')
    const html = night([halted])
    expect(arcs(html).some((t) => /stroke-dasharray="3 3" class="stroke-amber-400"/.test(t))).toBe(
      true,
    )
  })
})

describe('Tape and scorebug in light (review §4.6, §4.7)', () => {
  it('draws the grid and borders in rule-faint, the crosshair in brass on an ink label', () => {
    expect(TAPE_FRAME).toEqual({
      text: COLORS['ash-400'],
      grid: COLORS['rule-faint'],
      crosshair: COLORS['brass-700'],
      crosshairLabel: COLORS['ivory-100'],
    })
  })

  it('marks a run in ink-muted for either team: the words say whose run', () => {
    const runs = findRuns(history(), market().pubkey)
    const teams = { home: 'CLE', away: 'MEM' }
    const times = new Set(runs.map((r) => r.to))
    const markers = runMarkers(runs, teams, times)
    expect(markers.length).toBeGreaterThan(0)
    for (const m of markers) expect(m.color).toBe(COLORS['ash-400'])
    const away = runMarkers(
      runs.map((r) => ({ ...r, team: 'away' as const })),
      teams,
      times,
    )
    for (const m of away) expect(m.color).toBe(COLORS['ash-400'])
  })

  it('sets the scorebug run line in ink-muted, off the old amber', () => {
    const [run] = findRuns(history(), market().pubkey)
    const html = renderToStaticMarkup(<Scorebug game={game()} run={run ?? null} />)
    expect(html).toMatch(/font-mono text-12 text-ash-400" data-run/)
    expect(html).not.toContain('text-amber-400')
  })
})
