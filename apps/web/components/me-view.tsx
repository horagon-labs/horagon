'use client'
// My Game-day (R7): the night's calls of this browser's play wallet, one card per game, scored
// against the model; Practice apart; the next games of the fan's teams; the key block, open.
// It polls GET /api/v1/me/{wallet} every 5 s (the API reads the DB only); MeScreen draws it.
import type { MeGame, MeResponse } from '@horagon/sdk'
import { isHoragonError } from '@horagon/sdk/errors'
import Link from 'next/link'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { DISABLED } from '../lib/chrono/controls'
import { MODEL_HINT } from '../lib/chrono/copy'
import { useNow } from '../lib/chrono/now'
import { etClock } from '../lib/chrono/time'
import { loadFollows } from '../lib/follows'
import { gameClock, percent } from '../lib/format'
import {
  callLine,
  headline,
  ifWinsParts,
  KEYS_NOTE,
  MONEY_CLASS,
  meTeams,
  nextRow,
  nightLabel,
  PRACTICE_NOTE,
  pointsText,
  positionLine,
  priceLine,
  SCORE_RULE,
  STATUS_TEXT,
  statusOf,
} from '../lib/me'
import { usePoll } from '../lib/use-poll'
import { SOMETHING_WRONG, WALLET_PREPARING } from '../lib/wallet-copy'
import { NightChip } from './chrono/night-chip'
import { ErrorText } from './error-text'
import { KeyBackup } from './key-backup'
import { useWallet } from './wallet'

/** The page's poll: the API reads the DB only, and a call settles in seconds, not minutes. */
export const ME_POLL_MS = 5_000

const HEADING = 'text-13 font-medium uppercase tracking-[0.2em] text-ink'
const LINK = 'inline-flex min-h-11 items-center text-15 text-ink underline-offset-4 hover:underline'
// The header's chip look (light branding review §4.8): a rule edge, ink words.
const BUTTON = `min-h-11 rounded-full border border-rule px-4 text-13 text-ink ${DISABLED}`

export interface MeScreenProps {
  /** The wallet has been read from this browser. */
  loaded: boolean
  address: string | null
  me: MeResponse | undefined
  error: Error | undefined
  /** Unix seconds. */
  now: number
  preparing: boolean
  setUpFailed: boolean
  onSetUp: () => void
  claiming: boolean
  claimError: unknown
  onClaimAll: () => void
}

/** The per-browser key block, always open on this page. */
function Keys() {
  return (
    <section className="space-y-2 rounded-card border border-rule p-4">
      <p className="text-13 text-ink">{KEYS_NOTE}</p>
      <KeyBackup open />
    </section>
  )
}

function Score(p: { game: MeGame['game'] }) {
  const g = p.game
  if (g.status === 'scheduled') {
    return (
      <p className="font-mono text-13 text-ink-muted tabular-nums">
        tip-off {etClock(Math.floor(Date.parse(g.scheduledTipoff) / 1000))}
      </p>
    )
  }
  return (
    <p className="font-mono text-13 text-ink tabular-nums">
      {g.away} {g.awayScore ?? '–'} · {g.home} {g.homeScore ?? '–'} · {gameClock(g)}
    </p>
  )
}

function GameCard(p: { entry: MeGame; now: number }) {
  const { game: g, positions, practice } = p.entry
  const winner = g.markets.find((m) => m.kind === 'winner')
  const chance = priceLine(g, winner, p.now)
  const ifWins = ifWinsParts(p.entry)
  return (
    // A sheet on the paper, edged in the faint rule like the Position card (review §4.7).
    <li className="space-y-2 rounded-card border border-rule-faint bg-surface-raised p-4">
      {practice && <p className={HEADING}>Practice</p>}
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <Link
          href={`/game/${g.id}`}
          className="inline-flex min-h-11 items-center text-15 font-semibold text-ink underline-offset-4 hover:underline"
        >
          {g.away} @ {g.home}
        </Link>
        <Score game={g} />
      </div>
      {chance.text && <p className="font-mono text-15 text-ink tabular-nums">{chance.text}</p>}
      {chance.live && (
        <>
          <p className="text-13 text-ink">
            Model: {g.home} {percent(g.modelProb)}
          </p>
          <p className="text-12 text-ink-muted">{MODEL_HINT}</p>
        </>
      )}
      <ul className="divide-y divide-rule">
        {positions.map((pos) => {
          const status = statusOf(pos, g, p.now)
          const call = callLine(pos, g)
          return (
            <li key={`${pos.market}-${pos.side}`} className="space-y-1 py-2 text-13">
              <p className="font-mono text-ink tabular-nums">{positionLine(pos)}</p>
              {call && <p className="text-ink">{call}</p>}
              <p className={STATUS_TEXT[status.state]}>{status.line}</p>
              {status.result && (
                <p className="font-semibold text-ink">
                  {status.claimUsdc ? (
                    <>
                      You won · <span className={MONEY_CLASS}>{status.claimUsdc}</span> to claim
                    </>
                  ) : (
                    status.result
                  )}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      {ifWins && (
        // Each net in one ink with its sign printed, + or − (light branding review §4.7).
        <p className="font-mono text-12 text-ink-muted tabular-nums">
          {ifWins.map((x, i) => (
            <Fragment key={x.lead}>
              {i > 0 && ' · '}
              {x.lead} (<span className={MONEY_CLASS}>{x.net}</span>)
            </Fragment>
          ))}
        </p>
      )}
    </li>
  )
}

/** One Claim all for anything claimable, tonight or earlier: the wallet's own run. */
function ClaimAll(p: MeScreenProps & { me: MeResponse }) {
  const tonight = p.me.games.some((e) => e.positions.some((x) => x.claimable))
  const earlier = p.me.earlierClaimable
  // "more" only when cards sit above the line; under "No calls tonight yet." it is just "N to claim".
  const more = p.me.games.some((e) => !e.practice) ? 'more ' : ''
  if (!tonight && earlier === 0 && !p.claiming) return null
  return (
    <div className="space-y-2">
      {earlier > 0 && (
        <p className="text-13 text-ink-muted">
          {`${earlier} ${more}${earlier === 1 ? 'position' : 'positions'} to claim.`}
        </p>
      )}
      <button
        type="button"
        disabled={p.claiming || p.preparing}
        onClick={p.onClaimAll}
        className={`min-h-11 w-full rounded-card bg-ink py-2 font-semibold text-surface ${DISABLED}`}
      >
        {p.claiming ? 'Claiming…' : p.preparing ? WALLET_PREPARING : 'Claim all'}
      </button>
      <ErrorText error={p.claimError} />
    </div>
  )
}

function NextGames(p: { games: MeResponse['nextGames'] }) {
  return (
    <section className="space-y-2">
      <h2 className={HEADING}>Next game for your teams</h2>
      {p.games.length === 0 ? (
        <p className="text-13 text-ink-muted">
          Follow teams on Tonight&apos;s board to see their next games here.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {p.games.map((g) => (
            <li key={g.id}>
              <Link
                href={`/game/${g.id}`}
                className="inline-flex min-h-11 items-center font-mono text-13 text-ink tabular-nums underline-offset-4 hover:underline"
              >
                {nextRow(g)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Night(p: MeScreenProps & { me: MeResponse }) {
  const { me } = p
  const nba = me.games.filter((e) => !e.practice)
  const practice = me.games.filter((e) => e.practice)
  return (
    <>
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <p className={HEADING}>{nightLabel(me.night)}</p>
          <NightChip nights={me.nights} />
        </div>
        <p className="text-24 font-semibold text-ink">{headline(me.vsModel)}</p>
        <p className="text-13 text-ink-muted">{SCORE_RULE}</p>
      </section>
      {nba.length === 0 ? (
        <div className="space-y-1">
          <p className="text-15 text-ink">No calls tonight yet.</p>
          <Link href="/" className={LINK}>
            Tonight&apos;s games
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {nba.map((e) => (
            <GameCard key={e.game.id} entry={e} now={p.now} />
          ))}
        </ul>
      )}
      <ClaimAll {...p} />
      {practice.length > 0 && (
        <section className="space-y-2">
          <h2 className={HEADING}>Practice</h2>
          <p className="text-13 text-ink-muted">{PRACTICE_NOTE}</p>
          {me.vsModel.practicePoints !== null && (
            <p className="text-15 font-semibold text-ink">
              Practice vs the model: {pointsText(me.vsModel.practicePoints)}
            </p>
          )}
          <ul className="space-y-3">
            {practice.map((e) => (
              <GameCard key={e.game.id} entry={e} now={p.now} />
            ))}
          </ul>
        </section>
      )}
      <NextGames games={me.nextGames} />
    </>
  )
}

/** The flag is off: the API answers the route with 404 (requireFlags). */
const switchedOff = (err: unknown): boolean => isHoragonError(err) && err.code === 'NOT_FOUND'

export function MeScreen(p: MeScreenProps) {
  let body: ReactNode
  if (!p.loaded) {
    body = <p className="text-13 text-ink-muted">Loading the wallet…</p>
  } else if (!p.address) {
    body = (
      <div className="space-y-2">
        <p className="text-15 text-ink">No play wallet in this browser yet.</p>
        <button type="button" disabled={p.preparing} onClick={p.onSetUp} className={BUTTON}>
          {p.preparing ? WALLET_PREPARING : 'Set up wallet'}
        </button>
        {p.setUpFailed && (
          <p role="alert" className="text-12 text-error">
            {SOMETHING_WRONG}
          </p>
        )}
      </div>
    )
  } else if (switchedOff(p.error)) {
    body = <p className="text-15 text-ink">My Game-day is switched off right now.</p>
  } else if (p.me) {
    body = <Night {...p} me={p.me} />
  } else if (p.error) {
    body = <ErrorText error={p.error} />
  } else {
    body = <p className="text-13 text-ink-muted">Loading your night…</p>
  }
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-24 font-semibold text-ink">My Game-day</h1>
      {body}
      {p.loaded && <Keys />}
    </div>
  )
}

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function MeView() {
  const w = useWallet()
  const now = useNow()
  // Followed teams are read once from this browser; nothing polls before, so the first request
  // already carries them.
  const [follows, setFollows] = useState<string[] | null>(null)
  const [setUpFailed, setSetUpFailed] = useState(false)
  // Only codes the API takes, at most 30 (meTeams): one odd follow never breaks the page.
  useEffect(() => setFollows(meTeams(loadFollows(storage()))), [])

  const address = w.address
  const key = address && follows ? `me:${address}:${follows.join(',')}` : null
  const poll = usePoll(key, () => api.me(address ?? '', follows ?? []), ME_POLL_MS)

  // A Claim all run that ended changes the night: read it again at once.
  const claimingBefore = useRef(w.claiming)
  const { refresh } = poll
  useEffect(() => {
    if (claimingBefore.current && !w.claiming) refresh()
    claimingBefore.current = w.claiming
  }, [w.claiming, refresh])

  const me = poll.data?.wallet === address ? poll.data : undefined
  return (
    <MeScreen
      loaded={w.loaded}
      address={address}
      me={me}
      error={poll.error}
      now={now || me?.now || 0}
      preparing={w.preparing}
      setUpFailed={setUpFailed}
      onSetUp={() => {
        setSetUpFailed(false)
        w.openGate().catch(() => setSetUpFailed(true))
      }}
      claiming={w.claiming}
      claimError={w.claimError}
      onClaimAll={w.startClaims}
    />
  )
}
