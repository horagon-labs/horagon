import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NIGHTS_TARGET as SDK_NIGHTS_TARGET } from '@horagon/sdk'
import { HoragonError } from '@horagon/sdk/errors'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RING } from '../components/chrono/dial-look'
import { NightChip } from '../components/chrono/night-chip'
import { KeyBackup } from '../components/key-backup'
import { MeScreen, type MeScreenProps } from '../components/me-view'
import { WalletProvider } from '../components/wallet'
import {
  at,
  game,
  market,
  meGame,
  mePosition,
  meResponse,
  NOW,
  WALLET,
} from '../lib/chrono/fixtures'
import { DIAL_STATES } from '../lib/chrono/state'
import {
  callLine,
  chipLabel,
  headline,
  ifWinsLine,
  ifWinsParts,
  meTeams,
  NIGHTS_TARGET,
  nextRow,
  nightLabel,
  PRACTICE_NOTE,
  pointsText,
  positionLine,
  proposedLine,
  SCORE_RULE,
  STATUS_TEXT,
  statusOf,
  streakLabel,
} from '../lib/me'

const WEB = join(import.meta.dirname, '..')

describe('the night chip words (lib/me.ts)', () => {
  it('counts nights, never a streak: null at 0, "Night n of 3", then "Night n"', () => {
    expect(streakLabel(0)).toBeNull()
    expect(streakLabel(1)).toBe('Night 1 of 3')
    expect(streakLabel(3)).toBe('Night 3 of 3')
    expect(streakLabel(4)).toBe('Night 4')
  })

  it('aims at the SDK’s target, declared here so the header loads no SDK index', () => {
    expect(NIGHTS_TARGET).toBe(SDK_NIGHTS_TARGET)
    // Types only: a type import is erased, a value import would load the SDK index.
    expect(readFileSync(join(WEB, 'lib', 'me.ts'), 'utf8')).not.toMatch(
      /^import (?!type )[^\n]*from '@horagon\/sdk'/m,
    )
  })

  it('says what the chip counts, and that it has no value', () => {
    expect(chipLabel(2)).toBe('You made calls on 2 NBA nights. No value, no prizes.')
    expect(chipLabel(1)).toBe('You made calls on 1 NBA night. No value, no prizes.')
  })
})

describe('the score against the model', () => {
  it('signs the points', () => {
    expect(pointsText(38)).toBe('+38')
    expect(pointsText(-62)).toBe('-62')
    expect(pointsText(0)).toBe('0')
  })

  it('heads the page with the night, or says nothing is settled yet', () => {
    expect(headline({ points: 38, settled: 1, pending: 0, practicePoints: null })).toBe(
      'You vs the model: +38 tonight',
    )
    expect(headline({ points: null, settled: 0, pending: 2, practicePoints: null })).toBe(
      'You vs the model: no result yet tonight',
    )
  })

  it('explains the rule in one line, with no value', () => {
    expect(SCORE_RULE).toBe(
      "Each call scores its result (100 if your team won, 0 if not) minus the model's % for that team when you called it. The model expects 0. No value, no prizes.",
    )
  })

  it('labels the night by its own date, not by the clock after midnight', () => {
    expect(nightLabel('2026-11-27')).toBe('Tonight · Fri, Nov 27')
    expect(nightLabel('2026-11-28')).toBe('Tonight · Sat, Nov 28')
  })
})

describe('a position card’s lines', () => {
  it('shows team, shares, the price in and now', () => {
    expect(positionLine(mePosition())).toBe('MEM · 38.72 shares · in at 55% · now 62%')
    expect(positionLine(mePosition({ price: null, avgPrice: null }))).toBe(
      'MEM · 38.72 shares · in at — · now —',
    )
  })

  it('shows what each side pays and the net', () => {
    expect(ifWinsLine(meGame())).toBe('If MEM wins: 38.72 mUSDC (+18.72) · If LAC wins: 0 (−20.00)')
    expect(ifWinsLine(meGame({ ifHomeWins: null, ifAwayWins: null }))).toBeNull()
  })

  it('splits each side into its payout and its net, the sign printed (review §4.7)', () => {
    expect(ifWinsParts(meGame())).toEqual([
      { lead: 'If MEM wins: 38.72 mUSDC', net: '+18.72' },
      { lead: 'If LAC wins: 0', net: '−20.00' },
    ])
    expect(ifWinsParts(meGame({ ifHomeWins: null, ifAwayWins: null }))).toBeNull()
  })

  it('shows the call: at the model, then won, lost, pending or not scored', () => {
    const g = meGame().game
    expect(callLine(mePosition(), g)).toBe('Called MEM at model 62% · pending')
    expect(callLine(mePosition({ call: { model: 0.62, result: 'won', points: 38 } }), g)).toBe(
      'Called MEM at model 62% · won · +38',
    )
    expect(callLine(mePosition({ call: { model: 0.62, result: 'lost', points: -62 } }), g)).toBe(
      'Called MEM at model 62% · lost · -62',
    )
    expect(
      callLine(mePosition({ call: { model: 0.5, result: 'lost', points: null } }), {
        ...g,
        status: 'postponed',
      }),
    ).toBe('Called MEM at model 50% · not scored')
    expect(callLine(mePosition({ call: null }), g)).toBeNull()
    expect(callLine(mePosition({ call: { model: null, result: null, points: null } }), g)).toBe(
      'Called MEM · no model to score against',
    )
  })

  it('lists a next game by its ET day and time', () => {
    const g = game({ home: 'MEM', away: 'LAC', scheduledTipoff: '2026-11-29T00:30:00.000Z' })
    expect(nextRow(g)).toBe('Sat, Nov 28 · 7:30 PM ET · LAC @ MEM')
  })
})

describe('each status line, from the dial state', () => {
  const end = at('2026-11-25T03:40:00Z')
  const g = (over: Parameters<typeof game>[0] = {}, m: Parameters<typeof market>[0] = {}) =>
    game({ home: 'MEM', away: 'LAC', markets: [market({ endTs: end, ...m })], ...over })

  it('open: until the final buzzer, end_ts at the latest', () => {
    expect(statusOf(mePosition(), g(), NOW)).toMatchObject({
      line: 'Open until the final buzzer · latest 10:40 PM ET',
      result: null,
      state: 'live',
    })
  })

  it('closed: the final score while the result is pending, halted or closed before it', () => {
    const final = g({ status: 'final', homeScore: 101, awayScore: 99 })
    expect(statusOf(mePosition({ status: 'closed' }), final, NOW).line).toBe(
      'Final · MEM won · result pending',
    )
    expect(
      statusOf(mePosition({ status: 'closed' }), g({}, { status: 'halted' }), NOW),
    ).toMatchObject({ line: 'Trading halted', state: 'halted' })
    expect(statusOf(mePosition({ status: 'closed' }), g(), end + 1)).toMatchObject({
      line: 'Trading closed',
      state: 'closed',
    })
  })

  it('proposed: the challenge countdown, then finalizing, or no time when it is unknown', () => {
    const proposed = g({ status: 'final' }, { status: 'proposed' })
    const p = (challengeEndsAt: number | null) =>
      mePosition({ status: 'proposed', challengeEndsAt })
    expect(statusOf(p(NOW + 754), proposed, NOW).line).toBe(
      'Result proposed · final in 12:34 unless a guardian challenges',
    )
    expect(statusOf(p(NOW), proposed, NOW).line).toBe('Challenge window closed · finalizing')
    expect(statusOf(p(null), proposed, NOW).line).toBe('Result proposed')
    expect(proposedLine(NOW + 754, NOW)).toBe(
      'Result proposed · final in 12:34 unless a guardian challenges',
    )
  })

  it('challenged: under review', () => {
    const challenged = g({ status: 'final' }, { status: 'challenged' })
    expect(statusOf(mePosition({ status: 'challenged' }), challenged, NOW).line).toBe(
      'Result under review',
    )
  })

  it('final: the result, then won to claim, won and claimed, or lost', () => {
    const won = g(
      { status: 'final', homeScore: 101, awayScore: 99 },
      { status: 'finalized', outcome: 'yes' },
    )
    const final = (over: Parameters<typeof mePosition>[0]) =>
      statusOf(mePosition({ status: 'final', ...over }), won, NOW)
    expect(final({ claimable: true, valueUsdc: '38.72' })).toMatchObject({
      line: 'Resolved: MEM won',
      result: 'You won · 38.72 mUSDC to claim',
      claimUsdc: '38.72 mUSDC',
    })
    expect(final({ claimable: false, shares: '0', valueUsdc: '0' }).claimUsdc).toBeNull()
    expect(final({ claimable: false, shares: '0', valueUsdc: '0' }).result).toBe(
      'You won · claimed',
    )
    expect(final({ side: 'away', team: 'LAC', claimable: false }).result).toBe('Lost')
  })

  it('takes each colour from the dial’s ring roles, as text', () => {
    // The ring's paint as a word's (light branding review §3.2, §3.3): live never colours a word,
    // so a live ring reads ink; void's bare rule line reads ink-muted, for 4.5:1.
    const WORD: Record<string, string> = {
      'ash-400': 'ink-muted',
      line: 'ink-muted',
      'amber-400': 'ink',
      live: 'ink',
      'red-400': 'error',
    }
    for (const s of DIAL_STATES) {
      expect(STATUS_TEXT[s], s).toBe(`text-${WORD[RING[s].replace('stroke-', '')]}`)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The page, rendered.

const props = (over: Partial<MeScreenProps> = {}): MeScreenProps => ({
  loaded: true,
  address: WALLET,
  me: meResponse(),
  error: undefined,
  now: NOW,
  preparing: false,
  setUpFailed: false,
  onSetUp: () => undefined,
  claiming: false,
  claimError: undefined,
  onClaimAll: () => undefined,
  ...over,
})
const page = (over: Partial<MeScreenProps> = {}) =>
  renderToStaticMarkup(
    <WalletProvider>
      <MeScreen {...props(over)} />
    </WalletProvider>,
  )

describe('My Game-day, rendered', () => {
  it('shows the night, the score, one card per game and the key block, open', () => {
    const html = page({ me: meResponse({ nights: 2 }) })
    expect(html).toContain('Tonight · Tue, Nov 24')
    expect(html).toContain('You vs the model: no result yet tonight')
    expect(html).toContain('href="/me"')
    expect(html).toContain('Night 2 of 3')
    expect(html).toContain('MEM to win · 62%')
    expect(html).toContain('Model: live win chance from score and clock')
    expect(html).toContain('MEM · 38.72 shares · in at 55% · now 62%')
    expect(html).toMatch(
      /If MEM wins: 38\.72 mUSDC \(<span[^>]*>\+18\.72<\/span>\) · If LAC wins: 0 \(<span[^>]*>−20\.00<\/span>\)/,
    )
    expect(html).toContain('Called MEM at model 62% · pending')
    expect(html).toContain('Open until the final buzzer · latest 10:40 PM ET')
    // The key block is always open on this page: never inside a <details>.
    expect(html).toContain(
      'This play wallet lives in this browser only. Another browser or phone shows a different wallet. Export the key to keep it; import it to use it elsewhere.',
    )
    expect(html).toContain('Show secret key')
    expect(html).not.toContain('<details')
  })

  it('sets money in one ink, the sign printed + or − (light branding review §4.7)', () => {
    const html = page()
    expect(html).toMatch(/<span class="text-ink">\+18\.72<\/span>/)
    expect(html).toMatch(/<span class="text-ink">−20\.00<\/span>/)
    expect(html).not.toMatch(/text-red-400|text-lume-300/)
    const won = game({
      home: 'MEM',
      away: 'LAC',
      status: 'final',
      homeScore: 101,
      awayScore: 99,
      markets: [market({ status: 'finalized', outcome: 'yes', endTs: at('2026-11-25T03:40:00Z') })],
    })
    const claim = page({
      me: meResponse({
        games: [
          meGame({
            game: won,
            positions: [mePosition({ status: 'final', claimable: true, valueUsdc: '38.72' })],
            ifHomeWins: null,
            ifAwayWins: null,
          }),
        ],
      }),
    })
    expect(claim).toMatch(/You won · <span class="text-ink">38\.72 mUSDC<\/span> to claim/)
  })

  it('reads closed on a final, resolved or void card: no "to win", no live Model line', () => {
    const end = at('2026-11-25T03:40:00Z')
    const card = (over: Parameters<typeof game>[0], m: Parameters<typeof market>[0]) =>
      page({
        me: meResponse({
          games: [
            meGame({
              game: game({
                home: 'MEM',
                away: 'LAC',
                markets: [market({ endTs: end, ...m })],
                ...over,
              }),
              positions: [mePosition({ status: 'closed' })],
              ifHomeWins: null,
              ifAwayWins: null,
            }),
          ],
        }),
      })
    const final = { status: 'final' as const, homeScore: 90, awayScore: 100 }
    // An open market under a final game: the scoreboard's words, never "MEM to win · 62%".
    const closed = card(final, {})
    expect(closed).toContain('MEM lost')
    const resolved = card(final, { status: 'finalized', outcome: 'no' })
    expect(resolved).toContain('Resolved: LAC won')
    const voided = card({ status: 'postponed' }, {})
    for (const html of [closed, resolved, voided]) {
      expect(html).not.toContain('to win')
      expect(html).not.toContain('Model: live win chance from score and clock')
      expect(html).not.toMatch(/Model: MEM \d/)
    }
  })

  it('folds the key block in the wallet sheet, unchanged', () => {
    const html = renderToStaticMarkup(
      <WalletProvider>
        <KeyBackup open={false} />
      </WalletProvider>,
    )
    expect(html).toMatch(/^<details><summary[^>]*>Export \/ Import<\/summary>/)
    expect(html).toContain('Show secret key')
    const sheet = readFileSync(join(WEB, 'components', 'wallet-sheet.tsx'), 'utf8')
    expect(sheet).toContain('<KeyBackup open={false} />')
    expect(sheet).not.toContain('Show secret key')
  })

  it('keeps the key block light: no key code, no trade code', () => {
    const src = readFileSync(join(WEB, 'components', 'key-backup.tsx'), 'utf8')
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(imports.sort()).toEqual(['../lib/wallet-copy', './age-dialog', './wallet', 'react'])
  })

  it('puts Practice apart, with its label and its rule', () => {
    const practice = meGame({
      practice: true,
      game: game({ id: 'prac-1', league: 'PRACTICE', home: 'CLE', away: 'CHA' }),
      positions: [mePosition({ team: 'CLE', gameId: 'prac-1' })],
    })
    const html = page({
      me: meResponse({
        games: [meGame(), practice],
        vsModel: { points: null, settled: 0, pending: 1, practicePoints: 60 },
      }),
    })
    expect(html).toContain(PRACTICE_NOTE)
    expect(PRACTICE_NOTE).toBe(
      'Practice calls are scored apart and never count toward your nights.',
    )
    expect(html.match(/>Practice</g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('Practice vs the model: +60')
  })

  it('offers one Claim all for tonight or earlier', () => {
    const claim = page({
      me: meResponse({ games: [meGame({ positions: [mePosition({ claimable: true })] })] }),
    })
    expect(claim.match(/Claim all/g)).toHaveLength(1)
    expect(page({ me: meResponse({ earlierClaimable: 2 }) })).toContain('Claim all')
    // Not on a card is not always earlier: a second-half market of tonight's game counts too.
    expect(page({ me: meResponse({ earlierClaimable: 2 }) })).toContain(
      '2 more positions to claim.',
    )
    expect(page({ me: meResponse({ earlierClaimable: 1 }) })).toContain('1 more position to claim.')
    expect(page({ me: meResponse({ earlierClaimable: 2 }) })).not.toContain('earlier')
    // With no card above it ("No calls tonight yet."), the line does not say "more".
    const bare = page({ me: meResponse({ games: [], earlierClaimable: 2 }) })
    expect(bare).toContain('2 positions to claim.')
    expect(bare).not.toContain('more')
    expect(page({ me: meResponse({ games: [], earlierClaimable: 1 }) })).toContain(
      '1 position to claim.',
    )
    expect(page()).not.toContain('Claim all')
    expect(page({ me: meResponse({ earlierClaimable: 1 }), preparing: true })).toContain(
      'Preparing…',
    )
  })

  it('lists the next games, or says how to get some', () => {
    const next = game({
      id: 'nba-9',
      home: 'MEM',
      away: 'LAC',
      status: 'scheduled',
      scheduledTipoff: '2026-11-29T00:30:00.000Z',
    })
    const html = page({ me: meResponse({ nextGames: [next] }) })
    expect(html).toContain('Next game for your teams')
    expect(html).toContain('href="/game/nba-9"')
    expect(html).toContain('Sat, Nov 28 · 7:30 PM ET · LAC @ MEM')
    expect(page()).toContain('Follow teams on Tonight&#x27;s board to see their next games here.')
  })

  it('says when there is no wallet, with a way to set one up and the key block', () => {
    const html = page({ address: null, me: undefined })
    expect(html).toContain('No play wallet in this browser yet.')
    expect(html).toContain('Set up wallet')
    expect(html).toContain('Show secret key')
    expect(page({ address: null, me: undefined, preparing: true })).toContain('Preparing…')
    expect(page({ address: null, me: undefined, setUpFailed: true })).toContain(
      'Something went wrong. Try again.',
    )
  })

  it('says when there are no calls tonight, with the way to the board', () => {
    const html = page({ me: meResponse({ games: [] }) })
    expect(html).toContain('No calls tonight yet.')
    expect(html).toMatch(/<a[^>]*href="\/"/)
  })

  it('says when My Game-day is switched off', () => {
    const html = page({
      me: undefined,
      error: new HoragonError('NOT_FOUND', 'This feature is not available right now'),
    })
    expect(html).toContain('My Game-day is switched off right now.')
    expect(html).not.toContain('No calls tonight yet.')
  })
})

describe('the followed teams sent to /me', () => {
  it('sends only team codes the API takes, at most 30, so one odd follow never breaks the page', () => {
    expect(meTeams(['MEM', 'lac', 'TOO-LONG', 'X', 'ABCDEF', 'LAC', 'MEM'])).toEqual(['MEM', 'LAC'])
    const many = Array.from(
      { length: 40 },
      (_, i) =>
        `T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
    )
    expect(meTeams(many)).toHaveLength(30)
    expect(meTeams(many)).toEqual(many.slice(0, 30))
  })

  it('is what the page polls with', () => {
    const src = readFileSync(join(WEB, 'components', 'me-view.tsx'), 'utf8')
    expect(src).toMatch(/meTeams\(loadFollows\(/)
  })
})

describe('the night chip', () => {
  it('is absent at 0 nights, and links to /me', () => {
    expect(renderToStaticMarkup(<NightChip nights={0} />)).toBe('')
    const html = renderToStaticMarkup(<NightChip nights={2} className="hidden sm:inline-flex" />)
    expect(html).toContain('href="/me"')
    expect(html).toContain('aria-label="You made calls on 2 NBA nights. No value, no prizes."')
    expect(html).toContain('Night 2 of 3')
    expect(html).toContain('hidden sm:inline-flex')
  })

  it('shows in the header and the sheet only while the portfolio carries nights', () => {
    const button = readFileSync(join(WEB, 'components', 'wallet-button.tsx'), 'utf8')
    expect(button).toMatch(/nights !== undefined/)
    expect(button).toContain('hidden sm:inline-flex')
    const sheet = readFileSync(join(WEB, 'components', 'wallet-sheet.tsx'), 'utf8')
    expect(sheet).toMatch(/nights !== undefined/)
    expect(sheet.indexOf('My Game-day')).toBeLessThan(sheet.indexOf('<Positions />'))
  })
})

describe('the /me page', () => {
  it('is titled My Game-day and kept out of search', async () => {
    const { metadata } = await import('../app/me/page')
    expect(metadata).toMatchObject({ title: 'My Game-day', robots: { index: false } })
  })
})
