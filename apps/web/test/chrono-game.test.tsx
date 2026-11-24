import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Resolution } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { beatArmed, isBeat, runKeyOf } from '../components/chrono/dial-look'
import { Gallery } from '../components/chrono/gallery'
import { GameLoading, GameScreen, NoGame } from '../components/chrono/game-screen'
import { MarketBlock } from '../components/chrono/market-block'
import { WalletProvider } from '../components/wallet'
import { detail, game, history, market, NOW } from '../lib/chrono/fixtures'
import { canTrade, gameDial } from '../lib/chrono/game'
import { findRuns, latestRun } from '../lib/chrono/runs'
import { DIAL_STATES } from '../lib/chrono/state'

const needle = (html: string) => html.match(/<g transform="([^"]+)"[^>]*data-needle="price"/)?.[1]

const SIG = '5'.repeat(88)
const proposal: Resolution = {
  market: market().pubkey,
  kind: 'winner',
  status: 'proposed',
  outcome: null,
  evidenceHash: 'a'.repeat(64),
  evidenceUrl: 'https://example.test/evidence.json',
  createSig: SIG,
  haltSig: null,
  proposeSig: SIG,
  finalizeSig: null,
  recycleSig: null,
  externalLp: false,
}

describe('gameDial (spec 4.2, 4.3)', () => {
  it('rings the time left from the real start_ts and reads the whole sentence', () => {
    expect(gameDial(game(), market(), NOW - 3_730, null, NOW)).toEqual({
      state: 'live',
      price: 0.77,
      timeLeft: 0.5,
      secsLeft: 3_730,
      label: 'CLE wins, 77 cents, model 74, closes in 1 hour 2 minutes',
    })
  })

  it('stands in tip-off - 60 min until the market state has loaded', () => {
    // Tip-off is 01:00 UTC, so the stand-in start is 00:00 UTC: 7,680 s before NOW.
    expect(gameDial(game(), market(), null, null, NOW).timeLeft).toBeCloseTo(3_730 / 11_410, 6)
  })

  it('turns the needle toward the proposed side once the evidence names it', () => {
    const final = game({ status: 'final' })
    const proposed = market({ status: 'proposed' })
    expect(gameDial(final, proposed, null, 'no', NOW).price).toBe(0)
    expect(gameDial(final, proposed, null, 'yes', NOW).price).toBe(1)
    expect(gameDial(final, proposed, null, null, NOW).price).toBe(0.77)
    expect(gameDial(final, proposed, null, 'no', NOW).state).toBe('proposed')
  })

  it('has no needle and a full ring before the market opens', () => {
    const later = game({ status: 'scheduled', markets: [] })
    expect(gameDial(later, undefined, null, null, NOW)).toEqual({
      state: 'pre',
      price: null,
      timeLeft: 1,
      secsLeft: null,
      label: 'CLE wins, no price yet, model 74, market opens 60 min before tip-off',
    })
  })

  it('trades only while the market is open', () => {
    expect(DIAL_STATES.filter(canTrade)).toEqual(['closing', 'live', 'pre'])
  })
})

describe('GameScreen (spec 4.2)', () => {
  const screen = (stale = false) =>
    renderToStaticMarkup(
      <GameScreen
        game={detail({ resolutions: [proposal] })}
        history={history()}
        dial={gameDial(game(), market(), NOW - 3_730, null, NOW)}
        now={NOW}
        stale={stale}
        right={<p data-slot="right">crown</p>}
      />,
    )

  it('stacks Scorebug, Dial, Tape, the crown block and the ResolutionCard in that order', () => {
    const html = screen()
    const order = [
      'data-column="left"',
      'CLE on an 8–0 run',
      'role="img"',
      'Times in ET',
      'data-column="right"',
      'data-slot="right"',
      'Challenge window',
      'Market rules',
    ].map((s) => html.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('puts the two halves side by side from 1024 px', () => {
    expect(screen()).toContain('lg:grid-cols-[minmax(0,1fr)_24rem]')
  })

  it('marks a failing poll on the dial and says it is reconnecting', () => {
    expect(screen()).not.toContain('Reconnecting…')
    const html = screen(true)
    expect(html).toContain('Reconnecting…')
    expect(html).toContain('data-stale')
  })
})

describe('GameLoading and NoGame (spec 4.4)', () => {
  it('holds the dial frame with the needle at 12 o’clock and no team', () => {
    const html = renderToStaticMarkup(<GameLoading stale={false} />)
    expect(needle(html)).toBe('rotate(0 100 100)')
    expect(html).toContain('aria-label="Loading game"')
    expect(html).not.toContain(' wins')
  })

  it('shows a still face that says there is no game, with the way back', () => {
    const html = renderToStaticMarkup(<NoGame />)
    expect(html).toContain('No game here')
    expect(html).toContain('href="/"')
    expect(needle(html)).toBeUndefined()
  })
})

describe('MarketBlock (spec 3.2, 4.2)', () => {
  it('offers the faucet before there is a wallet, then the positions, the crown in a sheet', () => {
    const g = detail()
    const html = renderToStaticMarkup(
      <WalletProvider>
        <MarketBlock
          game={g}
          market={market()}
          dial={gameDial(g, market(), NOW - 3_730, null, NOW)}
          now={NOW}
          stale={false}
          onMarketStale={() => {}}
        />
      </WalletProvider>,
    )
    const faucet = html.indexOf('Get test mUSDC')
    const sheet = html.indexOf('<dialog')
    const card = html.indexOf('Your position')
    expect(faucet).toBeGreaterThanOrEqual(0)
    expect(sheet).toBeGreaterThan(faucet)
    expect(card).toBeGreaterThan(sheet)
    expect(html).toContain('aria-label="Buy CLE"')
    expect(html).toContain('No positions yet.')
  })
})

describe('dev gallery (spec 6.2)', () => {
  it('adds the game screen, its stale line, the loading frame and the still face', () => {
    const html = renderToStaticMarkup(<Gallery />)
    expect(html).toContain('data-column="right"')
    expect(html).toContain('Reconnecting…')
    expect(html).toContain('aria-label="Loading game"')
    expect(html).toContain('No game here')
    expect(html).not.toContain('NaN')
  })
})

describe('wave 2 cleanup (spec 2.1)', () => {
  const web = join(import.meta.dirname, '..')
  const read = (...p: string[]) => readFileSync(join(web, ...p), 'utf8')
  const sources = (dir: string): string[] =>
    readdirSync(join(web, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => join(dir, f))

  it('keeps no dark: variant and no token of the old game page', () => {
    const css = read('app', 'globals.css')
    expect(css).not.toContain('@custom-variant dark')
    expect(css).not.toContain('--color-home')
    expect(css).not.toContain('--color-away')
    expect(read('app', 'layout.tsx')).not.toContain('`dark ')
    for (const f of [...sources('components'), ...sources('app')]) {
      expect(read(f), f).not.toMatch(/\bdark:|zinc-/)
    }
  })
})

describe('the run flash on page open (spec 2.4)', () => {
  const MKT = market().pubkey
  const keyOf = (h: ReturnType<typeof history> | undefined) =>
    runKeyOf(h, h ? latestRun(findRuns(h, MKT)) : null)

  it('has no key until history loads, and null for history with no run', () => {
    expect(keyOf(undefined)).toBeUndefined()
    expect(runKeyOf(history(), null)).toBeNull()
  })

  it('does not flash the old run on the first history load, then flashes for a new one', () => {
    const k0 = keyOf(undefined)
    const first = keyOf(history())
    expect(first).toEqual(expect.any(String))
    expect(isBeat({ key: k0, armed: beatArmed(false, k0) }, first)).toBe(false)
    expect(beatArmed(false, undefined)).toBe(false)
    expect(beatArmed(true, first)).toBe(false)
    expect(beatArmed(false, null)).toBe(true)
    expect(isBeat({ key: first, armed: beatArmed(false, first) }, 'MEM:99')).toBe(true)
  })
})

describe('GameLoading reconnecting (spec 4.4)', () => {
  it('says Reconnecting only while the poll is failing', () => {
    expect(renderToStaticMarkup(<GameLoading stale={false} />)).not.toContain('Reconnecting…')
    expect(renderToStaticMarkup(<GameLoading stale />)).toContain('Reconnecting…')
  })
})
