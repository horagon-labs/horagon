import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REFERENCE_AGENT_WALLET } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BOT_RATE as COUNT_FANS_BOT_RATE } from '../../../scripts/count-fans.mjs'
import AgentPage, { metadata } from '../app/agent/page'
import { AgentLine, AgentNote } from '../components/chrono/agent-line'
import { AGENT_DISCLOSURE, AGENT_PARAMS, activityLine, BOT_RATE } from '../lib/agent'
import { activity } from '../lib/chrono/fixtures'
import { explorerAddress } from '../lib/format'

const WEB = join(import.meta.dirname, '..')
const AGENT_SRC = join(WEB, '..', 'keeper', 'src', 'agent')
const read = (...path: string[]) => readFileSync(join(...path), 'utf8')

const tally = (swaps: number, volumeUsdc: string, wallets = swaps > 0 ? 1 : 0) => ({
  swaps,
  wallets,
  volumeUsdc,
})

describe('activityLine (R2b)', () => {
  it.each([
    ['no swaps at all', {}, 'No swaps yet'],
    [
      'the agent and fans',
      { agent: { ...tally(12, '840'), wallet: REFERENCE_AGENT_WALLET }, fans: tally(3, '45', 2) },
      'Reference agent: 12 swaps, 840.00 mUSDC · Fans: 3 swaps, 45.00 mUSDC',
    ],
    [
      'one swap each, in the singular',
      { agent: { ...tally(1, '100'), wallet: REFERENCE_AGENT_WALLET }, fans: tally(1, '0.5') },
      'Reference agent: 1 swap, 100.00 mUSDC · Fans: 1 swap, 0.50 mUSDC',
    ],
    [
      'the agent but no fan yet',
      { agent: { ...tally(12, '840'), wallet: REFERENCE_AGENT_WALLET } },
      'Reference agent: 12 swaps, 840.00 mUSDC · No fan trades yet: be the first to move it',
    ],
    [
      'fans only',
      { fans: tally(3, '1234.567891', 3) },
      'Reference agent: 0 swaps, 0.00 mUSDC · Fans: 3 swaps, 1,234.56 mUSDC',
    ],
    [
      'other team or bot wallets too',
      {
        agent: { ...tally(12, '840'), wallet: REFERENCE_AGENT_WALLET },
        fans: tally(3, '45'),
        others: tally(2, '7'),
      },
      'Reference agent: 12 swaps, 840.00 mUSDC · Fans: 3 swaps, 45.00 mUSDC · Other team or bot wallets: 2 swaps',
    ],
    [
      'one other swap, with the agent and no fan',
      { agent: { ...tally(2, '200'), wallet: REFERENCE_AGENT_WALLET }, others: tally(1, '1') },
      'Reference agent: 2 swaps, 200.00 mUSDC · No fan trades yet: be the first to move it · Other team or bot wallets: 1 swap',
    ],
    [
      'only other wallets',
      { others: tally(2, '7') },
      'Reference agent: 0 swaps, 0.00 mUSDC · Fans: 0 swaps, 0.00 mUSDC · Other team or bot wallets: 2 swaps',
    ],
  ])('%s', (_name, over, line) => {
    expect(activityLine(activity(over))).toBe(line)
  })

  it('says how the agent trades, word for word', () => {
    expect(AGENT_DISCLOSURE).toBe(
      'A disclosed Horagon agent trades toward the model, and only after 90 s without another trade. It never counts as a fan.',
    )
  })
})

describe('AGENT_PARAMS: the agent as built', () => {
  it('has the AGENT_* defaults of apps/keeper/src/agent/config.ts', () => {
    const src = read(AGENT_SRC, 'config.ts')
    const defaults = Object.fromEntries(
      [...src.matchAll(/^\s*(AGENT_[A-Z_]+): (?:int|num|musdc)\(([^)]*)\),$/gm)].map(
        ([, name, args]) => [
          name,
          Number((args ?? '').split(',').at(-1)?.trim().replace(/_/g, '')),
        ],
      ),
    )
    expect({
      intervalSecs: defaults.AGENT_INTERVAL_SECS,
      fanLagSecs: defaults.AGENT_FAN_LAG_SECS,
      modelMaxAgeSecs: defaults.AGENT_MODEL_MAX_AGE_SECS,
      endBufferSecs: defaults.AGENT_END_BUFFER_SECS,
      band: defaults.AGENT_BAND,
      stopShort: defaults.AGENT_STOP_SHORT,
      maxPerSwapUsdc: defaults.AGENT_MAX_PER_SWAP,
      maxPerGameUsdc: defaults.AGENT_MAX_PER_GAME,
      maxSwapsPerGame: defaults.AGENT_MAX_SWAPS_PER_GAME,
    }).toEqual({
      intervalSecs: AGENT_PARAMS.intervalSecs,
      fanLagSecs: AGENT_PARAMS.fanLagSecs,
      modelMaxAgeSecs: AGENT_PARAMS.modelMaxAgeSecs,
      endBufferSecs: AGENT_PARAMS.endBufferSecs,
      band: AGENT_PARAMS.band,
      stopShort: AGENT_PARAMS.stopShort,
      maxPerSwapUsdc: AGENT_PARAMS.maxPerSwapUsdc,
      maxPerGameUsdc: AGENT_PARAMS.maxPerGameUsdc,
      maxSwapsPerGame: AGENT_PARAMS.maxSwapsPerGame,
    })
  })

  it('has the hold of guards.ts and the horn of decide.ts', () => {
    expect(read(AGENT_SRC, 'guards.ts')).toContain(
      `export const ANOMALY_HOLD_SECS = ${AGENT_PARAMS.anomalyHoldSecs}\n`,
    )
    expect(read(AGENT_SRC, 'decide.ts')).toContain(
      `if (v.period >= ${AGENT_PARAMS.hornFromPeriod} && v.clockSecs === 0) return skip('horn')`,
    )
  })

  it('counts bots at the rate of scripts/count-fans.mjs', () => {
    expect(BOT_RATE).toEqual(COUNT_FANS_BOT_RATE)
  })
})

describe('AgentLine: who traded, under the dial (R2b)', () => {
  const other = '9v2ZmruntFtM4HmUFNq3Nn3rpXhV3uh8FmyRWafVbcHN'

  it('reads the counts and the wallet from the activity, and links /agent', () => {
    const a = activity({ agent: { ...tally(12, '840'), wallet: other }, fans: tally(3, '45') })
    const html = renderToStaticMarkup(<AgentLine activity={a} />)
    expect(html).toContain('Reference agent: 12 swaps, 840.00 mUSDC · Fans: 3 swaps, 45.00 mUSDC')
    expect(html).toContain(`<p>${AGENT_DISCLOSURE} <a `)
    expect(html).toMatch(/<a [^>]*href="\/agent"[^>]*>How the agent works<\/a>/)
    expect(html).toContain(`href="${explorerAddress(other).replace(/&/g, '&amp;')}"`)
    // The link's name is its visible text (WCAG 2.5.3).
    expect(html).toMatch(/<a [^>]*rel="noreferrer"[^>]*>Wallet 9v2Z…bcHN<\/a>/)
    expect(html).not.toContain('aria-label')
    expect(html).not.toContain(REFERENCE_AGENT_WALLET.slice(0, 4))
    // R5's 12 px floor, in the ash of a secondary line.
    expect(html).toMatch(/^<div[^>]*class="[^"]*text-12 font-mono text-ash-400/)
  })

  it('says so before any swap', () => {
    expect(renderToStaticMarkup(<AgentLine activity={activity()} />)).toContain('No swaps yet')
  })
})

describe('AgentNote: the line under the board on / (R2b)', () => {
  it('discloses the agent and links /agent', () => {
    const html = renderToStaticMarkup(<AgentNote />)
    expect(html).toContain(
      'When nobody trades, a disclosed Horagon agent moves prices toward the model. It never counts as a fan.',
    )
    expect(html).toMatch(/<a [^>]*href="\/agent"[^>]*>How the agent works<\/a><\/p>$/)
    expect(html.startsWith('<p')).toBe(true)
  })

  it('renders on / after the board, from the server page', () => {
    const page = read(WEB, 'app', 'page.tsx')
    expect(page).toMatch(/^import \{ AgentNote \} from '\.\.\/components\/chrono\/agent-line'$/m)
    const board = page.indexOf('<TonightBoard')
    expect(board).toBeGreaterThan(0)
    expect(page.indexOf('<AgentNote />')).toBeGreaterThan(board)
    // No client JS: agent-line.tsx is not a client module of its own.
    expect(read(WEB, 'components', 'chrono', 'agent-line.tsx')).not.toContain("'use client'")
  })
})

describe('/agent: how the reference agent works (R2b)', () => {
  const html = renderToStaticMarkup(<AgentPage />)
  const text = html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
  const p = AGENT_PARAMS

  it('has its title and description, in its share preview too', () => {
    const description =
      "How Horagon's disclosed reference agent trades, and why it never counts as a fan."
    expect(metadata.title).toBe('Reference agent')
    expect(metadata.description).toBe(description)
    expect(metadata.openGraph).toMatchObject({ title: 'Reference agent · Horagon', description })
    expect(metadata.twitter).toMatchObject({ title: 'Reference agent · Horagon', description })
  })

  it('shows the full wallet, linked to the explorer', () => {
    expect(text).toContain(REFERENCE_AGENT_WALLET)
    expect(html).toContain(
      `href="${explorerAddress(REFERENCE_AGENT_WALLET).replace(/&/g, '&amp;')}"`,
    )
  })

  it('shows the memo: its program, no accounts, horagon:bot, and none on claims', () => {
    expect(text).toContain('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
    expect(text).toContain('horagon:bot')
    expect(text).toContain('no accounts')
    expect(text).toContain('Claims carry no memo.')
  })

  it('states every rule with the numbers of AGENT_PARAMS', () => {
    for (const words of [
      `every ${p.intervalSecs} s`,
      `in the last ${p.endBufferSecs / 60} min before`,
      '3 h after tip-off',
      'The market itself closes at the final buzzer.',
      'at a 0:00 clock in the 4th quarter or overtime',
      `in the last ${p.modelMaxAgeSecs} s`,
      `in the last ${p.fanLagSecs} s`,
      `over ${p.band}`,
      `${p.stopShort} short of the model`,
      `${p.maxPerSwapUsdc} mUSDC cap`,
      `${p.maxPerSwapUsdc} mUSDC a swap`,
      `${p.maxPerGameUsdc.toLocaleString('en-US')} mUSDC and ${p.maxSwapsPerGame} swaps a market`,
      `for ${p.anomalyHoldSecs / 60} min`,
      'It starts in a dry run: it decides and sends nothing.',
      'never sells',
      'never uses the sponsor',
      'Off unless enabled',
    ]) {
      expect(text, words).toContain(words)
    }
    expect(p.hornFromPeriod).toBe(4)
  })

  it('says why it never counts and how this site counts', () => {
    for (const words of [
      'Team is checked first',
      'team-burner',
      'node scripts/count-fans.mjs',
      'whatever its memo',
      `${BOT_RATE.swaps} swaps on this game within ${BOT_RATE.seconds} s`,
      'live display',
    ]) {
      expect(text, words).toContain(words)
    }
  })

  it('links the sources on the public repo', () => {
    const repo = 'https://github.com/horagon-labs/horagon/blob/main'
    for (const path of [
      'docs/metrics.md',
      'docs/metrics-wallets.json',
      'apps/keeper/src/agent',
      'README.md#reference-agent',
    ]) {
      expect(html).toContain(`href="${repo}/${path}"`)
    }
  })

  it('is a static page: no connection(), no client module', () => {
    const src = read(WEB, 'app', 'agent', 'page.tsx')
    expect(src).not.toContain('connection')
    expect(src).not.toContain("'use client'")
    expect(src).toMatch(/^import \{ REFERENCE_AGENT_WALLET \} from '@horagon\/sdk'$/m)
  })
})
