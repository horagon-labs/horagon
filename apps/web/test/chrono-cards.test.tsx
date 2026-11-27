import type { Resolution } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PositionCard, type PositionCardProps } from '../components/chrono/position-card'
import { ResolutionCard } from '../components/chrono/resolution-card'
import { ErrorText } from '../components/error-text'
import { detail, market, NOW, portfolio, position } from '../lib/chrono/fixtures'
import { milestones } from '../lib/chrono/resolution'

const noop = () => {}
const SIG = '5'.repeat(88)

function resolution(over: Partial<Resolution> = {}): Resolution {
  return {
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
    gameMarket: 'GameMarket11111111111111111111111111111111',
    proposedAt: null,
    challengeEndsAt: null,
    ...over,
  }
}

const marks = (r: Resolution) => milestones(r, NOW).map((m) => [m.label, m.mark])

describe('milestones (spec 3.2, 4.3)', () => {
  it('waits on everything while the market trades', () => {
    expect(marks(resolution({ status: 'open', proposeSig: null }))).toEqual([
      ['Result proposed', 'next'],
      ['Challenge window', 'next'],
      ['Finalized', 'next'],
    ])
  })

  it('is in the challenge window after a proposal, under review after a challenge', () => {
    expect(marks(resolution())).toEqual([
      ['Result proposed', 'done'],
      ['Challenge window', 'now'],
      ['Finalized', 'next'],
    ])
    expect(marks(resolution({ status: 'challenged' }))[1]).toEqual(['Result under review', 'now'])
  })

  it('times the challenge window while proposed, and says when it closed (R6 part B)', () => {
    const timed = resolution({ challengeEndsAt: NOW + 754 })
    expect(milestones(timed, NOW)[1]).toEqual({
      label: 'Challenge window · 12:34 left',
      mark: 'now',
      sig: null,
    })
    expect(milestones(timed, NOW + 754)[1]?.label).toBe('Challenge window closed')
    expect(milestones(resolution(), NOW)[1]?.label).toBe('Challenge window')
    const review = resolution({ status: 'challenged', challengeEndsAt: null })
    expect(milestones(review, NOW)[1]?.label).toBe('Result under review')
  })

  it('is done once finalized, and adds the recycle when there is one', () => {
    const done = resolution({ status: 'recycled', finalizeSig: SIG, recycleSig: SIG })
    expect(marks(done)).toEqual([
      ['Result proposed', 'done'],
      ['Challenge window', 'done'],
      ['Finalized', 'done'],
      ['Recycled', 'done'],
    ])
  })
})

describe('ResolutionCard (spec 3.2)', () => {
  it('links the evidence with its sha256 and the market account', () => {
    const html = renderToStaticMarkup(
      <ResolutionCard game={detail({ resolutions: [resolution()] })} state="proposed" now={NOW} />,
    )
    expect(html).toContain('Result evidence (JSON)')
    expect(html).toContain(`sha256 ${'a'.repeat(64)}`)
    expect(html).toContain('Market on Solana Explorer')
    expect(html).toContain('Result proposed: the challenge window is open')
    expect(html).toContain('data-mark="now"')
    expect(html).toContain('Challenge window')
  })

  it('counts the challenge window down on its own clock (R6 part B)', () => {
    const timed = resolution({ challengeEndsAt: NOW + 754 })
    const card = (now: number) =>
      renderToStaticMarkup(
        <ResolutionCard game={detail({ resolutions: [timed] })} state="proposed" now={now} />,
      )
    expect(card(NOW)).toContain('Result proposed · final in 12:34 unless a guardian challenges')
    expect(card(NOW)).toContain('Challenge window · 12:34 left')
    expect(card(NOW + 1)).toContain('final in 12:33')
    expect(card(NOW + 754)).toContain('Challenge window closed · finalizing')
  })

  it('links /verify for the market beside the evidence (R6 part B)', () => {
    const html = renderToStaticMarkup(
      <ResolutionCard game={detail({ resolutions: [resolution()] })} state="proposed" now={NOW} />,
    )
    const evidence = html.indexOf('Result evidence (JSON)')
    const verify = html.indexOf(`href="/verify/${market().pubkey}"`)
    expect(verify).toBeGreaterThan(evidence)
    expect(html).toContain('Verify this result')
    // Nothing proposed yet: nothing to verify.
    const open = resolution({ status: 'open', evidenceHash: null, evidenceUrl: null })
    const none = renderToStaticMarkup(
      <ResolutionCard game={detail({ resolutions: [open] })} state="live" now={NOW} />,
    )
    expect(none).not.toContain('/verify/')
  })

  it('names the winner once there is an outcome, and shows nothing without a resolution', () => {
    const won = resolution({ status: 'finalized', outcome: 'yes', finalizeSig: SIG })
    const final = detail({ status: 'final', resolutions: [won] })
    expect(
      renderToStaticMarkup(<ResolutionCard game={final} state="resolved" now={NOW} />),
    ).toContain('Resolved: CLE won')
    expect(renderToStaticMarkup(<ResolutionCard game={detail()} state="live" now={NOW} />)).toBe('')
  })

  it('says the status from the dial state, never the raw "open" of a closed market (R5)', () => {
    const open = resolution({ status: 'open' })
    const final = detail({ status: 'final', homeScore: 105, awayScore: 107, resolutions: [open] })
    const html = renderToStaticMarkup(<ResolutionCard game={final} state="closed" now={NOW} />)
    expect(html).toContain(
      'Final MEM 107–105 CLE. The result goes on-chain automatically 3 h after tip-off, then a guardian has 15 minutes to challenge it.',
    )
    expect(html).not.toContain('Winner market')
  })
})

describe('PositionCard (spec 3.2)', () => {
  const card = (over: Partial<PositionCardProps> = {}) =>
    renderToStaticMarkup(
      <PositionCard
        gameId="nba-401810001"
        teams={{ home: 'CLE', away: 'MEM' }}
        portfolio={portfolio([position()])}
        canSell
        onSell={noop}
        claiming={false}
        claimed={[]}
        claimError={undefined}
        onClaim={noop}
        {...over}
      />,
    )

  it('shows paid, worth now and the payout if that team wins, with Sell', () => {
    const html = card()
    expect(html).toContain('CLE · 14.10 shares')
    expect(html).toContain('paid 10.00 · worth 10.85')
    expect(html).toContain('pays 14.10 mUSDC if CLE wins')
    expect(html).toContain('>Sell</button>')
  })

  it('says won or lost once the market has a result (M16)', () => {
    const result = { marketStatus: 'finalized', outcome: 'no' } as const
    const html = card({
      canSell: false,
      portfolio: portfolio([
        position({ ...result, valueUsdc: '0' }),
        position({ ...result, side: 'away', market: 'Mkt2', claimable: true }),
      ]),
    })
    expect(html).toContain('CLE lost')
    expect(html).toContain('MEM won')
    expect(html).not.toContain('pays')
  })

  it('lists the winner market only, with the same live diamond for either side', () => {
    const html = card({
      portfolio: portfolio([
        position(),
        position({ kind: 'second-half', shares: '7' }),
        position({ side: 'away', market: 'Mkt2' }),
      ]),
    })
    expect(html).not.toContain('7.00 shares')
    expect(html.match(/<li /g)).toHaveLength(2)
    expect(html.match(/class="text-live">◆</g)).toHaveLength(2)
    expect(html).not.toMatch(/(?:lume-300|brass-500)"[^>]*>◆/)
  })

  it('hides Sell once the market stopped trading, and says when there is nothing', () => {
    expect(card({ canSell: false })).not.toContain('>Sell</button>')
    expect(card({ portfolio: portfolio([]) })).toContain('No positions yet.')
  })

  it('makes Claim all a hold button that waits while a run is in flight', () => {
    const claimable = portfolio([position({ claimable: true, marketStatus: 'finalized' })])
    expect(card({ portfolio: claimable })).toMatch(/hold-safe[^>]*>.*Claim all/)
    expect(card({ portfolio: claimable, claiming: true })).toContain('Claiming…')
    expect(card({ claimed: [SIG] })).toContain('Claimed: view transaction')
    expect(card()).not.toContain('Claim all')
  })
})

describe('ErrorText (spec 6.1)', () => {
  it('keeps its words and drops the light theme', () => {
    const html = renderToStaticMarkup(<ErrorText error={new Error('{"raw":"json"}')} />)
    expect(html).toContain('Something went wrong. Try again.')
    expect(html).not.toContain('raw')
    expect(html).toContain('text-red-400')
    expect(html).not.toContain('dark:')
  })
})
