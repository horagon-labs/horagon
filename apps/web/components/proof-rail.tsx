// The proof rail on / (first-screen spec W6, C5, C6, C6m): under the hero, how a share pays and
// why a late call moves the price, both programs by name on the devnet explorer, and the real
// counts from GET /record. A server component: no hooks and no client module, so the program ids
// and the words ship in the HTML only. No Live blue here: nothing on the rail is an open market.
import { HORAGON_PROGRAM_ID, PM_AMM_PROGRAM_ID, type RecordResponse } from '@horagon/sdk'
import { Fragment, type ReactNode } from 'react'
import { explorerAddress, shortKey } from '../lib/format'

/** C5: matches /study ("decays on wall-clock time to a fixed end_ts"). */
export const MECHANISM_LINE =
  'Each share pays 1 mUSDC if its team wins. One pm-AMM pool per game; its liquidity thins toward a fixed end time, so a late call moves the price more.'

const POOLS = PM_AMM_PROGRAM_ID.toBase58()
const RESULTS = HORAGON_PROGRAM_ID.toBase58()

// Ink among muted words is under 3:1 against them, so links are underlined too (review §3.3).
const LINK = 'inline-flex min-h-11 items-center gap-1 text-ink underline underline-offset-4'

const Arrow = () => <span aria-hidden="true">↗</span>

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Explorer({ address, name }: { address: string; name: string }) {
  return (
    <a href={explorerAddress(address, 'devnet')} target="_blank" rel="noreferrer" className={LINK}>
      {name} {shortKey(address)} <Arrow />
    </a>
  )
}

/**
 * `record`: GET /record's counts; null (the API failed or was late) or no market yet leaves the
 * counts out, and the program links show at every width. `proofMarket`: the market the 375 rail
 * opens on /verify (the story's); null links the Horagon program on the explorer instead.
 */
export function ProofRail({
  record,
  proofMarket,
}: {
  record: RecordResponse | null
  proofMarket: string | null
}) {
  const counts = record !== null && record.markets > 0 ? record : null
  const parts: Array<[string, ReactNode]> = [
    [
      'pools',
      <>
        Pools: <Explorer address={POOLS} name="pm-AMM" />
      </>,
    ],
    [
      'results',
      <>
        Results: <Explorer address={RESULTS} name="Horagon program" />
      </>,
    ],
    ...(counts
      ? ([
          ['markets', count(counts.markets, 'market created', 'markets created')],
          ['final', count(counts.final, 'result final on chain', 'results final on chain')],
        ] as Array<[string, ReactNode]>)
      : []),
    [
      'study',
      // A plain <a>: next/link from a server component adds its own client chunk to / (3.2 KiB).
      <a key="study" href="/study" className={LINK}>
        How the model is checked
      </a>,
    ],
  ]
  const narrowLabel = counts
    ? `${count(counts.markets, 'market', 'markets')} · ${count(counts.final, 'result', 'results')} on chain`
    : ''
  return (
    <section aria-label="On chain" className="mb-5 space-y-1" data-proof-rail>
      <p className="hidden text-14 text-ink-muted sm:block" data-mechanism>
        {MECHANISM_LINE}
      </p>
      {counts && (
        <p className="font-mono text-12 tabular-nums sm:hidden" data-rail-narrow>
          {proofMarket ? (
            // A plain <a>: /verify loads as a new document, with its own CSP (R9).
            <a href={`/verify/${proofMarket}`} className={LINK}>
              {narrowLabel} <Arrow />
            </a>
          ) : (
            <a
              href={explorerAddress(RESULTS, 'devnet')}
              target="_blank"
              rel="noreferrer"
              className={LINK}
            >
              {narrowLabel} <Arrow />
            </a>
          )}
        </p>
      )}
      <p
        className={`${counts ? 'hidden sm:block ' : ''}font-mono text-12 text-ink-muted tabular-nums`}
        data-rail-wide
      >
        {/* A narrow line wraps between the parts, never inside one. */}
        {parts.map(([key, node], i) => (
          <Fragment key={key}>
            {i > 0 && ' · '}
            <span className="whitespace-nowrap">{node}</span>
          </Fragment>
        ))}
      </p>
    </section>
  )
}
