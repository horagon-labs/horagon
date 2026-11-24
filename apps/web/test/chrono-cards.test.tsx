import type { Resolution } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PositionCard, type PositionCardProps } from '../components/chrono/position-card'
import { ResolutionCard } from '../components/chrono/resolution-card'
import { ErrorText } from '../components/error-text'
import { detail, market, portfolio, position } from '../lib/chrono/fixtures'
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
    ...over,
  }
}

const marks = (r: Resolution) => milestones(r).map((m) => [m.label, m.mark])

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
      <ResolutionCard game={detail({ resolutions: [resolution()] })} />,
    )
    expect(html).toContain('Evidence JSON')
    expect(html).toContain(`sha256 ${'a'.repeat(64)}`)
    expect(html).toContain('Market account')
    expect(html).toContain('data-mark="now"')
    expect(html).toContain('Challenge window')
  })

  it('names the winner once there is an outcome, and shows nothing without a resolution', () => {
    const won = resolution({ status: 'finalized', outcome: 'yes', finalizeSig: SIG })
    expect(
      renderToStaticMarkup(<ResolutionCard game={detail({ resolutions: [won] })} />),
    ).toContain(' · CLE won')
    expect(renderToStaticMarkup(<ResolutionCard game={detail()} />)).toBe('')
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

  it('lists the winner market only, with a lume diamond for home and brass for away', () => {
    const html = card({
      portfolio: portfolio([
        position(),
        position({ kind: 'second-half', shares: '7' }),
        position({ side: 'away', market: 'Mkt2' }),
      ]),
    })
    expect(html).not.toContain('7.00 shares')
    expect(html.match(/<li /g)).toHaveLength(2)
    expect(html).toMatch(/text-lume-300"[^>]*>\s*◆[\s\S]*text-brass-500"[^>]*>\s*◆/)
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
