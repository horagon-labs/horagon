// R8: Practice is labelled everywhere and never looks like a real night. The plate, string 26,
// the recording and the counterparty line on a Practice game; its title, card and resolution
// heading; no share button; the strip on `/` and the /practice page's states.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PracticeResponse } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GameScreen } from '../components/chrono/game-screen'
import { PracticeNote, PracticePlate } from '../components/chrono/practice-plate'
import { PracticeStrip } from '../components/chrono/practice-strip'
import { ResolutionCard } from '../components/chrono/resolution-card'
import { detail, game, history, market, NOW } from '../lib/chrono/fixtures'
import { gameDial } from '../lib/chrono/game'
import {
  COUNTERPARTY_AGENT,
  COUNTERPARTY_NONE,
  counterpartyLine,
  isPractice,
  PRACTICE_LINE,
  PRACTICE_RECORDINGS,
  practicePage,
  practiceStrip,
  recordedLine,
} from '../lib/chrono/practice'
import { gameCard, gameMeta } from '../lib/meta'

const WEB = join(import.meta.dirname, '..')
const REPLAY = join(WEB, '..', '..', 'tests', 'fixtures', 'replay')

/** Run 0 replays MEM @ CLE (ESPN 401910007), recorded on Nov 18 ET. */
const run = (over: Parameters<typeof detail>[0] = {}) =>
  detail({ id: 'practice-401910007p0', league: 'PRACTICE', ...over })

const resp = (over: Partial<PracticeResponse> = {}): PracticeResponse => ({
  current: null,
  nextAt: null,
  counterparty: 'none',
  ...over,
})

describe('the Practice words', () => {
  it('says string 26 and the two counterparty lines word for word', () => {
    expect(PRACTICE_LINE).toBe('Replay · a recorded night · practice calls never count')
    expect(counterpartyLine('none')).toBe(
      'No one else trades this replay. The price moves only when someone calls.',
    )
    expect(counterpartyLine('agent')).toBe(
      'The reference agent (horagon:bot) trades this replay too, toward the model.',
    )
    expect(COUNTERPARTY_NONE).toBe(counterpartyLine('none'))
    expect(COUNTERPARTY_AGENT).toBe(counterpartyLine('agent'))
  })

  it('tells a Practice game from an NBA one by its league only', () => {
    expect(isPractice(run())).toBe(true)
    expect(isPractice(detail())).toBe(false)
  })

  it('names the recording: "Recorded Nov 18 ET · MEM @ CLE"', () => {
    expect(recordedLine(run())).toBe('Recorded Nov 18 ET · MEM @ CLE')
    // A later run of the same recording (tag p1c) names the same night.
    expect(recordedLine(run({ id: 'practice-401910007p1c' }))).toBe(
      'Recorded Nov 18 ET · MEM @ CLE',
    )
    // A recording this build does not know: no date rather than a wrong one.
    expect(recordedLine(run({ id: 'practice-499999999p0' }))).toBe('A recorded game · MEM @ CLE')
  })

  it('knows every recording the keeper replays, with its ET date', () => {
    const files = readdirSync(REPLAY).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    const fromFiles = Object.fromEntries(
      files.map((f) => {
        const j = JSON.parse(readFileSync(join(REPLAY, f), 'utf8')) as {
          espnEventId: string
          gameDate: string
        }
        return [j.espnEventId, j.gameDate]
      }),
    )
    expect(PRACTICE_RECORDINGS).toEqual(fromFiles)
  })
})

describe('a Practice game on the game screen', () => {
  it('wears the PRACTICE plate in the story-plate style', () => {
    const html = renderToStaticMarkup(<PracticePlate />)
    expect(html).toContain('data-practice-plate')
    expect(html).toContain('>Practice<')
    for (const c of ['rounded-full', 'border-brass', 'text-ink', 'uppercase', 'text-12']) {
      expect(html).toContain(c)
    }
    expect(html).toContain('tracking-[0.16em]')
    expect(html).toContain('font-semibold')
  })

  it('says string 26, the recording and who else trades, honestly', () => {
    const none = renderToStaticMarkup(<PracticeNote game={run()} counterparty="none" />)
    expect(none).toContain(PRACTICE_LINE)
    expect(none).toContain('Recorded Nov 18 ET · MEM @ CLE')
    expect(none).toContain(COUNTERPARTY_NONE)
    expect(none).not.toContain(COUNTERPARTY_AGENT)
    const agent = renderToStaticMarkup(<PracticeNote game={run()} counterparty="agent" />)
    expect(agent).toContain(COUNTERPARTY_AGENT)
    expect(agent).not.toContain(COUNTERPARTY_NONE)
    // Not known (the API did not answer): no claim either way.
    const unknown = renderToStaticMarkup(<PracticeNote game={run()} counterparty={null} />)
    expect(unknown).toContain(PRACTICE_LINE)
    expect(unknown).not.toContain(COUNTERPARTY_NONE)
    expect(unknown).not.toContain(COUNTERPARTY_AGENT)
  })

  it('drops the agent disclosure under the dial unless the agent trades the replay', () => {
    const screen = (g: ReturnType<typeof run>, counterparty?: 'agent' | 'none' | null) =>
      renderToStaticMarkup(
        <GameScreen
          game={g}
          history={history()}
          dial={gameDial(g, g.markets[0], null, null, NOW)}
          now={NOW}
          stale={false}
          right={null}
          counterparty={counterparty}
        />,
      )
    // "No one else trades this replay" must not sit beside "a disclosed agent trades".
    expect(screen(run(), 'none')).not.toContain('data-agent-line')
    expect(screen(run(), null)).not.toContain('data-agent-line')
    expect(screen(run(), 'agent')).toContain('data-agent-line')
    // An NBA game keeps it.
    expect(screen(detail())).toContain('data-agent-line')
  })

  it('titles the page and the card "Practice · MEM @ CLE …"', () => {
    const m = gameMeta(run(), NOW)
    expect(m.title).toBe('Practice · MEM @ CLE · CLE to win 77%')
    expect(m.description).toContain(PRACTICE_LINE)
    expect(gameCard(run(), NOW).matchup).toBe('Practice · MEM @ CLE')
    // An NBA game keeps its title.
    expect(gameMeta(detail(), NOW).title).toBe('MEM @ CLE · CLE to win 77%')
  })

  it('has no share button: the game view leaves it out for a Practice game', () => {
    const src = readFileSync(join(WEB, 'components', 'game-view.tsx'), 'utf8')
    expect(src).toMatch(/practice \? \(\s*<PracticePlate \/>\s*\) : \(\s*<ShareButton/)
  })

  it('heads the resolution card "Practice result on-chain"', () => {
    const resolutions = [
      {
        market: market().pubkey,
        kind: 'winner' as const,
        status: 'open' as const,
        outcome: null,
        evidenceHash: null,
        evidenceUrl: null,
        createSig: null,
        haltSig: null,
        proposeSig: null,
        finalizeSig: null,
        recycleSig: null,
        externalLp: false,
      },
    ]
    const practice = renderToStaticMarkup(
      <ResolutionCard game={run({ resolutions } as never)} state="live" now={NOW} />,
    )
    expect(practice).toContain('Practice result on-chain')
    const nba = renderToStaticMarkup(
      <ResolutionCard game={detail({ resolutions } as never)} state="live" now={NOW} />,
    )
    expect(nba).not.toContain('Practice result')
    expect(nba).toContain('>Resolution<')
  })
})

describe('the strip on / and the /practice page', () => {
  const liveRun = game({ id: 'practice-401910007p0', league: 'PRACTICE', status: 'live' })

  it('says "Practice game live · MEM @ CLE · Replay" while a run is on', () => {
    expect(practiceStrip(resp({ current: liveRun }), NOW)).toEqual({
      text: 'Practice game live · MEM @ CLE · Replay',
      href: '/game/practice-401910007p0',
    })
  })

  it('names the next tip-off in ET and the minutes to it', () => {
    // NOW is 9:08 PM ET; 47 min later is 9:55 PM ET.
    expect(practiceStrip(resp({ nextAt: NOW + 47 * 60 }), NOW)).toEqual({
      text: 'Next practice tip-off 9:55 PM ET · in 47 min',
      href: '/practice',
    })
    expect(practiceStrip(resp({ nextAt: NOW + 2 * 3600 + 5 * 60 }), NOW)?.text).toBe(
      'Next practice tip-off 11:13 PM ET · in 2 h 5 min',
    )
    // A run that has not tipped off yet is the next tip-off.
    const soon = game({
      id: 'practice-401910007p0',
      league: 'PRACTICE',
      status: 'scheduled',
      scheduledTipoff: new Date((NOW + 300) * 1000).toISOString(),
    })
    expect(practiceStrip(resp({ current: soon, nextAt: NOW + 7_200 }), NOW)).toEqual({
      text: 'Next practice tip-off 9:13 PM ET · in 5 min',
      href: '/game/practice-401910007p0',
    })
  })

  it('says nothing with no run and no next tip-off, or with the flag off', () => {
    expect(practiceStrip(resp(), NOW)).toBeNull()
    expect(practiceStrip(null, NOW)).toBeNull()
    // A finished run with nothing next: nothing to point at.
    const done = { ...liveRun, status: 'final' as const }
    expect(practiceStrip(resp({ current: done }), NOW)).toBeNull()
  })

  it('renders the strip as one server line, a link with no script', () => {
    const html = renderToStaticMarkup(
      <PracticeStrip strip={{ text: 'Practice game live · MEM @ CLE · Replay', href: '/x' }} />,
    )
    expect(html).toContain('data-practice-strip')
    expect(html).toContain('href="/x"')
    expect(html).toContain('Practice game live · MEM @ CLE · Replay')
    expect(renderToStaticMarkup(<PracticeStrip strip={null} />)).toBe('')
    const src = readFileSync(join(WEB, 'components', 'chrono', 'practice-strip.tsx'), 'utf8')
    expect(src).not.toContain("'use client'")
  })

  it('sends /practice to the run in flight, else names the next tip-off', () => {
    expect(practicePage(resp({ current: liveRun }), NOW)).toEqual({
      redirect: '/game/practice-401910007p0',
    })
    expect(practicePage(resp({ nextAt: NOW + 47 * 60 }), NOW)).toEqual({
      line: 'Next practice tip-off 9:55 PM ET · in 47 min',
    })
    expect(practicePage(resp(), NOW)).toEqual({ line: 'No practice game is on the schedule yet.' })
    expect(practicePage(null, NOW)).toBeNull()
  })
})
