// "How the model is checked" (R10): the mechanism study, drawn on the server from the committed
// snapshot (content/study.json). Every number ships with its sample size and no claim of skill;
// the depth curve and the simulation are labelled for what they are. No hooks, no client module.
import {
  ELO_CARRYOVER,
  ELO_HOME_ADVANTAGE,
  ELO_K,
  ELO_MEAN,
  P0_MAX,
  P0_MIN,
} from '@horagon/sdk/model'
import { type StudySnapshot, UPSET_MAX_BPS } from '@horagon/sdk/study'
import type { ReactNode } from 'react'
import { explorerAddress, percent, shortKey } from '../lib/format'
import { DepthChart, LossChart } from './study-charts'

export const STUDY_TITLE = 'How the model is checked'
/** The sample line stays until the table holds this many games. */
export const SAMPLE_FLOOR = 100
const COMMAND = 'pnpm --filter @horagon/keeper study'

// Ink among muted words is under 3:1 against them, so links are underlined too (review §3.3).
const LINK = 'inline-flex min-h-11 items-center text-ink underline underline-offset-4'
const LIST = 'list-disc space-y-1 pl-5'
const TABLE_WRAP = 'overflow-x-auto'
const TABLE = 'w-full border-collapse font-mono text-13 tabular-nums'
const TH = 'border-b border-rule py-1 pr-3 text-left font-sans text-12 font-medium text-ink-muted'
const TD = 'border-b border-rule py-1 pr-3 text-ink'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-15 font-semibold text-ink">{title}</h2>
      {children}
    </section>
  )
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="break-all font-mono text-13 text-ink">{children}</code>
)

const dayLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})
const day = (date: string) => dayLabel.format(new Date(`${date}T12:00:00Z`))
const weekday = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

const score = (v: number | null) => (v === null ? '–' : v.toFixed(3))
/** A price move as % points with one decimal: "+1.2". */
const move = (v: number | null) => (v === null ? '–' : `+${(v * 100).toFixed(1)}`)
const hm = (minutes: number) => `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`
/** 180 -> "S+3h00m". */
const offset = (minutes: number) =>
  `S+${Math.floor(minutes / 60)}h${String(Math.round(minutes % 60)).padStart(2, '0')}m`
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`

/** "N games over K ET nights (dates). Far too few…": shown while N < SAMPLE_FLOOR. */
export function sampleLine(s: StudySnapshot): string {
  const nights = s.nights.map((n) => n.night)
  const dates =
    nights.length === 0
      ? ''
      : nights.length <= 4
        ? ` (${nights.map(day).join(', ')})`
        : ` (${day(nights[0] as string)} to ${day(nights.at(-1) as string)})`
  const games = `${s.calibration.n} game${s.calibration.n === 1 ? '' : 's'}`
  const over = `${nights.length} ET night${nights.length === 1 ? '' : 's'}`
  return `${games} over ${over}${dates}. Far too few to judge calibration; the table is published so anyone can check it as nights add up.`
}

function ScoreTable({ s }: { s: StudySnapshot }) {
  const c = s.calibration
  return (
    <div className={TABLE_WRAP}>
      <table className={TABLE}>
        <thead>
          <tr>
            <th className={TH} scope="col">
              Score
            </th>
            <th className={TH} scope="col">
              The model
            </th>
            <th className={TH} scope="col">
              A constant 50%
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th className={`${TD} font-sans`} scope="row">
              Brier score
            </th>
            <td className={TD}>{score(c.brier)}</td>
            <td className={TD}>{score(c.baselineBrier)}</td>
          </tr>
          <tr>
            <th className={`${TD} font-sans`} scope="row">
              Log loss
            </th>
            <td className={TD}>{score(c.logLoss)}</td>
            <td className={TD}>{score(c.baselineLogLoss)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function BinTable({ s }: { s: StudySnapshot }) {
  return (
    <div className={TABLE_WRAP}>
      <table className={TABLE}>
        <thead>
          <tr>
            <th className={TH} scope="col">
              Favourite at the open
            </th>
            <th className={TH} scope="col">
              Games
            </th>
            <th className={TH} scope="col">
              Favourite won
            </th>
            <th className={TH} scope="col">
              Mean opening
            </th>
          </tr>
        </thead>
        <tbody>
          {s.calibration.bins.map((b) => (
            <tr key={b.from} data-bin={b.from}>
              <td className={TD}>
                {b.from}–{b.to}%
              </td>
              <td className={TD}>{b.count}</td>
              <td className={TD}>{b.count === 0 ? '–' : `${b.favouriteWon} of ${b.count}`}</td>
              <td className={TD}>{b.meanForecast === null ? '–' : percent(b.meanForecast)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function NightTable({ s }: { s: StudySnapshot }) {
  if (s.nights.length === 0) return null
  return (
    <div className={TABLE_WRAP}>
      <table className={TABLE}>
        <thead>
          <tr>
            {[
              'ET night',
              'Games',
              'Brier',
              'Log loss',
              'Upsets',
              `From ${day(s.firstCountedNight)}`,
            ].map((h) => (
              <th key={h} className={TH} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.nights.map((n) => (
            <tr key={n.night}>
              <td className={TD}>{day(n.night)}</td>
              <td className={TD}>{n.n}</td>
              <td className={TD}>{score(n.brier)}</td>
              <td className={TD}>{score(n.logLoss)}</td>
              <td className={TD}>{n.upsets}</td>
              <td className={TD}>{n.counted ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RowTable({ s }: { s: StudySnapshot }) {
  if (s.rows.length === 0) return null
  return (
    <div className={TABLE_WRAP}>
      <table className={TABLE}>
        <thead>
          <tr>
            {['ET night', 'Game', 'Home opened', 'Winner', 'Market'].map((h) => (
              <th key={h} className={TH} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...s.rows].reverse().map((r) => (
            <tr key={r.market}>
              <td className={TD}>{day(r.night)}</td>
              <td className={TD}>
                {r.away} @ {r.home}
              </td>
              <td className={TD}>{percent(r.initialPriceBps / 10_000)}</td>
              <td className={TD}>{r.outcome === 'home' ? r.home : r.away}</td>
              <td className={TD}>
                <a
                  href={explorerAddress(r.market, 'devnet')}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink underline underline-offset-4"
                >
                  {shortKey(r.market)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The depth table: the two buys at a few minutes, for both end_ts offsets. */
function DepthTable({ depth }: { depth: StudySnapshot['depth'] }) {
  const minutes = [0, 60, 90, 120, 150]
  return (
    <div className={TABLE_WRAP}>
      <table className={TABLE}>
        <thead>
          <tr>
            <th className={TH} scope="col">
              Minute
            </th>
            {depth.curves.map((c) => (
              <th key={c.endOffsetSecs} className={TH} scope="col">
                end_ts {offset(c.endOffsetSecs / 60)}: 10 / 100
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {minutes.map((m) => (
            <tr key={m}>
              <td className={TD}>{m}</td>
              {depth.curves.map((c) => {
                const p = c.points.find((x) => x.minute === m)
                return (
                  <td key={c.endOffsetSecs} className={TD}>
                    {p ? `${move(p.move10)} / ${move(p.move100)}` : 'closed'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function StudyView({ snapshot: s }: { snapshot: StudySnapshot }) {
  const [today, before] = s.depth.curves
  const endMinutes = (today?.endOffsetSecs ?? 10_800) / 60
  const beforeMinutes = (before?.endOffsetSecs ?? 7_800) / 60
  const medianDepth = Math.sqrt(
    Math.max(0, endMinutes - s.depth.medianFinalMinutes) /
      (endMinutes + s.depth.createLeadSecs / 60),
  )
  return (
    <article className="mx-auto max-w-2xl space-y-6 py-4 text-15 text-ink-muted">
      <header className="space-y-2">
        <h1 className="text-24 font-semibold text-ink">{STUDY_TITLE}</h1>
        <p>
          Before every game the model gives the home team a win chance. That % is the market&apos;s
          opening price: it is written on chain when the market opens, 60 min before tip-off, and it
          cannot change after that. Anyone can score it against the results from chain alone.
        </p>
      </header>

      <Section title="The model">
        <ul className={LIST}>
          <li>
            Team Elo ratings from every NBA result of 2025-26 and of this season so far: K = {ELO_K}
            , home court worth {ELO_HOME_ADVANTAGE} points, {ELO_CARRYOVER * 100}% carried over
            between seasons toward {ELO_MEAN}.
          </li>
          <li>
            The rating gap becomes the home team&apos;s win chance, kept between {P0_MIN * 100}% and{' '}
            {P0_MAX * 100}% so no market opens near certain.
          </li>
          <li>
            It sees no injuries, rest days or lineups. The in-game model behind the ▲ on the dial is
            another model and is not scored here.
          </li>
          <li>
            The opening price sits in the pm-AMM Market account as <Code>initialPriceBps</Code>,
            next to <Code>winningSide</Code>; YES means the home team wins.
          </li>
        </ul>
      </Section>

      <Section title="The score so far">
        {s.generatedAt === null && (
          <p>The first table is published after the script&apos;s first run.</p>
        )}
        {s.calibration.n < SAMPLE_FLOOR && (
          <p className="text-ink" data-sample-line>
            {sampleLine(s)}
          </p>
        )}
        <ScoreTable s={s} />
        <p className="text-13">
          Lower is better for both. Every resolved NBA winner market ever created counts.{' '}
          {s.calibration.upsets} of {s.calibration.n} were upsets.
        </p>
        <h3 className="pt-2 text-14 font-semibold text-ink">Folded to the favourite</h3>
        <BinTable s={s} />
        {s.nights.length > 0 && (
          <>
            <h3 className="pt-2 text-14 font-semibold text-ink">Night by night</h3>
            <p className="text-13">
              Nights from {weekday.format(new Date(`${s.firstCountedNight}T12:00:00Z`))} on can be
              read apart from the earlier ones.
            </p>
            <NightTable s={s} />
          </>
        )}
      </Section>

      <Section title="Check it yourself">
        <p>
          With <Code>HORAGON_RPC_URL</Code> set to a devnet RPC, run:
        </p>
        <pre className="overflow-x-auto rounded-card border border-rule bg-surface-raised p-3 font-mono text-13 text-ink">
          {COMMAND}
        </pre>
        <ul className={LIST}>
          <li>
            It checks the RPC is devnet, reads every GameMarket of the horagon program (
            <Code>{s.programIds.horagon}</Code>) and the pm-AMM Market each one points at (
            <Code>{s.programIds.pmAmm}</Code>), and writes <Code>apps/web/content/study.json</Code>.
          </li>
          <li>It sends nothing and holds no key.</li>
          <li>
            A market counts when it is a winner market of an NBA game and its pm-AMM account is
            resolved (<Code>winningSide</Code> 1 is YES, 2 is NO).
          </li>
          {s.generatedAt !== null && (
            <li>
              This table: slot {s.slot ?? '–'}, made {utc(s.generatedAt)}.
            </li>
          )}
          {s.missing.length > 0 && (
            <li>
              Left out because the account is gone:{' '}
              {s.missing.map((m) => `${m.away} @ ${m.home} (${day(m.night)})`).join(', ')}.
            </li>
          )}
        </ul>
        <RowTable s={s} />
      </Section>

      <Section title="How deep the pool is">
        <p>
          Each market opens with a {s.depth.seedUsdc} mUSDC seed {s.depth.createLeadSecs / 60} min
          before tip-off. Its liquidity decays on wall-clock time to a fixed end_ts,{' '}
          {endMinutes / 60} h after the scheduled tip-off (L_eff = L0·√(T − t)). Timeouts, free
          throws and overtime do not slow it, so the same buy moves the price more as end_ts nears.
        </p>
        <p>
          The market itself closes at the final buzzer. Over 268 recorded games the median Final
          came {hm(s.depth.medianFinalMinutes)} after tip-off, with about{' '}
          {Math.round(medianDepth * 100)}% of the opening depth left. Before the buzzer close,
          end_ts was {hm(beforeMinutes)} after tip-off, earlier than the median Final.
        </p>
        <DepthChart depth={s.depth} />
        <p className="text-13">
          A 100 mUSDC buy on a 50% pool, the 2% fee taken: solid line end_ts at {hm(endMinutes)},
          dashed line {hm(beforeMinutes)}, brass line the median Final. The table gives the move in
          % points for a 10 and a 100 mUSDC buy.
        </p>
        <DepthTable depth={s.depth} />
      </Section>

      <Section title="Where a pool's value goes">
        <p className="text-ink">
          Simulation, not chain data · seed {s.lpSim.seed} · {s.lpSim.paths.toLocaleString('en-US')}{' '}
          paths
        </p>
        <p>
          The pm-AMM paper models the score as a random walk that decides the winner at end_ts.
          These seeded paths run that model, with an arbitrageur who trades the pool to the fair
          price after each liquidity step. The paper predicts the liquidity provider loses value at
          an even rate, half the starting value by end_ts.
        </p>
        <LossChart sim={s.lpSim} />
        <p className="text-13">
          Bars: the simulated loss in each sixth of the market&apos;s life, in % of the starting
          value. Dashed line: the even-rate prediction. In all,{' '}
          {(s.lpSim.totalLoss * 100).toFixed(1)}% against{' '}
          {(s.lpSim.predictedTotal * 100).toFixed(0)}
          %.
        </p>
      </Section>

      <Section title="The upset rule">
        <p>
          A game is an upset when its winner opened at {UPSET_MAX_BPS / 100}% or less. Last night on
          the dial, on the home page, uses the same rule.
        </p>
      </Section>

      <Section title="Sources">
        <ul className={LIST}>
          <li>
            <a
              href="https://github.com/horagon-labs/horagon/blob/main/apps/keeper/scripts/study.ts"
              className={LINK}
            >
              The script (apps/keeper/scripts/study.ts)
            </a>
          </li>
          <li>
            <a
              href="https://github.com/horagon-labs/horagon/blob/main/packages/sdk/src/study"
              className={LINK}
            >
              The scores, the depth curve and the simulation (packages/sdk/src/study)
            </a>
          </li>
        </ul>
      </Section>
    </article>
  )
}
