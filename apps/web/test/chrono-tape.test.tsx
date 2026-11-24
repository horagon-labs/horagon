import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Scorebug } from '../components/chrono/scorebug'
import { Tape } from '../components/chrono/tape'
import { game, history, market, NOW } from '../lib/chrono/fixtures'
import { findRuns } from '../lib/chrono/runs'
import { periodLabel, periodStarts, runMarkers, tapeCents, tapeTime } from '../lib/chrono/tape'
import { COLORS } from '../lib/chrono/tokens'

const MKT = market().pubkey
const TEAMS = { home: 'CLE', away: 'MEM' }
const t = NOW - 900

describe('tape (spec 3.2)', () => {
  it('starts a quarter line where the period goes up, labelled the way the clock says it', () => {
    expect(periodStarts(history().snapshots)).toEqual([{ ts: t + 60, period: 3, label: 'Q3' }])
    expect([4, 5, 6].map(periodLabel)).toEqual(['Q4', 'OT', '2OT'])
  })

  it('reads every chart time as unix seconds for the ET axis', () => {
    expect(tapeTime(NOW as Parameters<typeof tapeTime>[0])).toBe(NOW)
    expect(tapeTime('2026-11-25T02:08:00Z')).toBe(NOW)
    expect(tapeTime({ year: 2026, month: 11, day: 25 })).toBe(Date.UTC(2026, 10, 25) / 1000)
  })

  it('reads axis and crosshair prices inside 0-100¢, with no float noise at the edges', () => {
    expect(tapeCents(-0.02)).toBe('0¢')
    expect(tapeCents(1.02)).toBe('100¢')
    expect(tapeCents(1e-12)).toBe('0¢')
    expect(tapeCents(1 - 1e-12)).toBe('100¢')
    expect(tapeCents(0.004)).toBe('<1¢')
    expect(tapeCents(0.996)).toBe('>99¢')
    expect(tapeCents(0.5)).toBe('50¢')
  })

  it('marks a run at its last basket on the model line, in its side’s color', () => {
    const runs = findRuns(history(), MKT)
    expect(runMarkers(runs, TEAMS, new Set([t + 240]))).toEqual([
      {
        time: t + 240,
        position: 'aboveBar',
        shape: 'circle',
        color: COLORS['lume-300'],
        text: 'CLE 8–0',
      },
    ])
    expect(runMarkers(runs, TEAMS, new Set([t + 239]))).toEqual([])
  })

  it('names its two lines and the ET axis', () => {
    const html = renderToStaticMarkup(
      <Tape history={history()} market={MKT} home="CLE" away="MEM" />,
    )
    expect(html).toContain('━ Market (CLE wins)')
    expect(html).toContain('┅ Model')
    expect(html).toContain('Times in ET')
  })
})

describe('Scorebug (spec 3.2)', () => {
  it('shows the score, the clock with a live dot and the newest run', () => {
    const [run] = findRuns(history(), MKT)
    const html = renderToStaticMarkup(<Scorebug game={game()} run={run ?? null} />)
    expect(html).toContain('>78</p>')
    expect(html).toContain('>84</p>')
    expect(html).toContain('Q3 4:12')
    expect(html).toContain('data-live')
    expect(html).toContain('CLE on an 8–0 run · price 74 → 77 in 2 min')
  })

  it('shows the ET tip-off and no score before the game', () => {
    const later = game({ status: 'scheduled', scheduledTipoff: '2026-11-25T03:30:00Z' })
    const html = renderToStaticMarkup(<Scorebug game={later} run={null} />)
    expect(html).toContain('tip-off 10:30 PM ET')
    expect(html.match(/>–<\/p>/g)).toHaveLength(2)
    expect(html).not.toContain('data-live')
    expect(html).not.toContain('data-run')
  })
})
