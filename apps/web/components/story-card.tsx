// The story card (first-screen spec W2, C7-C12, G1): while no NBA market is open, one real game of
// the newest final night takes the board's dial slot: the eyebrow, the plate and what happened,
// the model's line on a tape with its low ringed, a readout resting on the low (from sm), and the
// result's proof on /verify. `compact` keeps the eyebrow, line 1 and the proof (S3/S4, under the
// Night dial). `lg-full` is compact below lg and full from lg (S6: under the Practice card at 375,
// beside it from lg), with the wide tape alone. The line draws once on first paint, then the low's
// ring and the readout fade in (globals.css `.story-draw`, `.story-at-low`; the end frame under
// reduced motion). A server component with plain links only (next/link from a server component
// added a client chunk to /, slice 2), no style attribute and no script (R9 CSP) and no Live blue:
// nothing here is an open market.
import type { Night, NightGame } from '@horagon/sdk'
import type { PracticeStripLine } from '../lib/chrono/practice'
import {
  type LastNightRow,
  lastNightHeadParts,
  nightDayLabel,
  upsetCount,
} from '../lib/server/last-night'
import { storyLines, type Tape, type TapeBox, tapeModel } from '../lib/server/story'
import { HowItWorks } from './chrono/hero'
import { MiniDial } from './chrono/mini-dial'
import { PracticeStrip } from './chrono/practice-strip'
import { StoryPlate } from './chrono/story-plate'
import { NightRowList } from './last-night'

/** C15: the culture's thesis, at the idle face's foot (decision 3: not in the hero). */
export const SIGN_OFF = 'Game time, kept.'

// Ink among muted words is under 3:1 against them, so links are underlined too (review §3.3).
const LINK = 'inline-flex min-h-11 items-center gap-1 text-13 text-ink underline underline-offset-4'

/**
 * The tape below sm (343 px wide at 375) and from sm (544 px in the 34rem column). `font`: the
 * labels' size in viewBox units, about 12 px on screen at both widths.
 */
const NARROW: Required<TapeBox> & { font: number } = {
  w: 340,
  h: 96,
  pad: { top: 16, right: 4, bottom: 16, left: 4 },
  font: 12,
}
/**
 * A moved card's tape below sm: 12 px shorter, as the card carries more rows (the legend, the
 * buzzer price, the tally), so the first board row stays above the 375 fold (§9). The plot loses
 * the height; the label bands keep theirs, so "Final" still sits above a line ending at the top.
 */
const NARROW_MOVED: typeof NARROW = { ...NARROW, h: 84 }
const WIDE: Required<TapeBox> & { font: number } = {
  w: 600,
  h: 132,
  pad: { top: 18, right: 6, bottom: 18, left: 6 },
  font: 13,
}

/** A page-coloured halo under each label, so the line it crosses never cuts its letters. */
const HALO = { paintOrder: 'stroke', strokeWidth: 3, strokeLinejoin: 'round' } as const

/** A label's baseline above a point, or under it when the top edge is too close. */
const above = (y: number, top = 10) => (y - 6 >= top ? y - 6 : y + 13)

/**
 * The draw (spec §4, G1): a mask holding a copy of the line on pathLength 1, its dash offset run
 * from 1 to 0 by `.story-draw` (globals.css). The visible line keeps its own dashes. The region
 * is the svg's own: a flat line's box has no height, and a box-sized mask would hide it.
 */
function DrawMask({ id, d, box }: { id: string; d: string; box: typeof NARROW }) {
  return (
    <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={box.w} height={box.h}>
      {/* A mask's white shows what it covers: 8 units cover the 1.5-2 px line. */}
      <path
        d={d}
        pathLength={1}
        fill="none"
        stroke="white"
        strokeWidth={8}
        className="story-draw"
      />
    </mask>
  )
}

function TapeSvg({
  tape,
  box,
  openedBelow,
  className,
  id,
}: {
  tape: Tape
  box: typeof NARROW
  /** The line climbs off the open: its label goes under the dot, clear of the line. */
  openedBelow: boolean
  className: string
  /** Unique on the page: the two tapes' masks must not share an id. */
  id: string
}) {
  const { w, h, pad } = box
  const top = pad.top
  const bottom = h - pad.bottom
  const left = pad.left
  const right = w - pad.right
  const text = 'fill-ink-muted stroke-surface font-mono'
  const low = tape.low
  // The low's % under its ring when there is room above the period labels, else over it (the
  // line rises on both sides of a low, so the space right above it is clear).
  const lowY = low ? (low.y + 15 <= bottom ? low.y + 15 : low.y - 9) : 0
  const lowX = low ? Math.min(Math.max(low.x, left + 12), right - 12) : 0
  const openedY =
    openedBelow && tape.opened.y + 13 <= bottom - 2 ? tape.opened.y + 13 : above(tape.opened.y)
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      className={`w-full overflow-visible ${className}`}
      data-tape
    >
      <defs>
        <DrawMask id={`${id}-model`} d={tape.model} box={box} />
        {tape.price && <DrawMask id={`${id}-price`} d={tape.price} box={box} />}
      </defs>
      <line x1={left} y1={bottom} x2={right} y2={bottom} className="stroke-rule-faint" />
      {tape.rules.map((x) => (
        <line key={x} x1={x} y1={top} x2={x} y2={bottom} className="stroke-rule-faint" />
      ))}
      {tape.periods.map((p) => (
        <text
          key={p.label}
          x={p.x}
          y={h - 4}
          textAnchor="middle"
          fontSize={box.font}
          {...HALO}
          className={text}
        >
          {p.label}
        </text>
      ))}
      <path
        d={tape.model}
        fill="none"
        strokeWidth={1.5}
        strokeDasharray="4 3"
        vectorEffect="non-scaling-stroke"
        mask={`url(#${id}-model)`}
        className="stroke-ink"
        data-tape-model
      />
      {tape.price && (
        <path
          d={tape.price}
          fill="none"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          mask={`url(#${id}-price)`}
          className="stroke-ink"
          data-tape-price
        />
      )}
      <circle cx={tape.opened.x} cy={tape.opened.y} r={2.5} className="fill-ink" />
      <text x={tape.opened.x + 5} y={openedY} fontSize={box.font} {...HALO} className={text}>
        {tape.opened.label}
      </text>
      <text
        x={right}
        y={above(tape.final.y)}
        textAnchor="end"
        fontSize={box.font}
        {...HALO}
        className={text}
      >
        {tape.final.label}
      </text>
      {low && (
        // Once the line is drawn, the ring and its % fade in on the low and rest there (G1).
        <g className="story-at-low">
          <circle
            cx={low.x}
            cy={low.y}
            r={5}
            fill="none"
            strokeWidth={1.5}
            className="stroke-ink"
            data-tape-low
          />
          <text
            x={lowX}
            y={lowY}
            textAnchor="middle"
            fontSize={box.font}
            {...HALO}
            className="fill-ink stroke-surface font-mono font-medium"
          >
            {low.label}
          </text>
        </g>
      )}
    </svg>
  )
}

export interface StoryCardProps {
  /** The night and its story game (lib/server/api.ts `initialStory`). */
  story: { night: Night; game: NightGame }
  /** Unix seconds: the eyebrow's day words and a proposed result's countdown. */
  now: number
  /** `lg-full`: compact below lg, full from lg (S6, while the Practice card leads). */
  variant?: 'full' | 'compact' | 'lg-full'
  /** Compact only (S3/S4): the night's other games under the proof (A4). */
  rows?: readonly LastNightRow[]
}

export function StoryCard({ story, now, variant = 'full', rows }: StoryCardProps) {
  const { night, game } = story
  const s = storyLines(game, now)
  const head = lastNightHeadParts(night, now)
  const full = variant !== 'compact'
  // From lg only: the tape, the readout, line 2 and the tally hide below lg, and the narrow tape
  // (below sm) is never shown, so it is not drawn.
  const lgOnly = variant === 'lg-full'
  const nbox = game.moved ? NARROW_MOVED : NARROW
  const narrow = full && !lgOnly ? tapeModel(game, nbox) : null
  const wide = full ? tapeModel(game, WIDE) : null
  const tape = narrow ?? wide
  const low = game.low
  // Where the model climbs off the open, "opened 28%" sits under its dot.
  const early = game.model.slice(0, Math.max(2, Math.ceil(game.model.length * 0.15)))
  const openedBelow = early.some(([, p]) => p > game.openedBps / 10_000 + 0.02)
  const agentAt = s.tally ? s.tally.parts[2].lastIndexOf('reference agent') : -1
  return (
    <section
      aria-labelledby="story-title"
      className="space-y-2"
      data-story-card={variant}
      data-story-game={game.id}
    >
      <h2 id="story-title" className="text-13 font-medium uppercase tracking-[0.2em] text-ink">
        {/* The night's count only beside the rows that show its other upsets (fresh-eyes note 1):
            the compact card lists them at every width; the full card's foot folds them below
            lg, where the summary says how many sit inside. */}
        {full ? (
          <>
            {head.head}
            <span className="hidden lg:inline">{` · ${head.upsets}`}</span>
          </>
        ) : (
          `${head.head} · ${head.upsets}`
        )}
      </h2>
      {/* The plate flows with the words (no flex row): a long line 1 wraps beside the plate, not
          under it, which keeps a moved card's first board row above the 375 fold (§9). */}
      <p className="text-15 font-medium text-ink">
        {s.plate && (
          <>
            <span className="mr-1">
              <StoryPlate story={s.plate} />
            </span>{' '}
          </>
        )}
        <span>{s.line1}</span>
      </p>
      {full && s.readout && low && (
        // Fades in with the low's ring, once the line is drawn (G1, spec §4).
        <div
          className={`hidden items-center gap-4 pt-1 ${lgOnly ? 'lg:flex' : 'sm:flex'} story-at-low`}
          data-readout
        >
          {/* MiniDial is 48 px; its 96 px use here sizes the svg from the box. A model low gets
              the model's ink ▲; a price low the price's needle, ash once trading stopped, so
              each glyph keeps its one meaning and matches the legend (C11). */}
          <div className="size-24 shrink-0 [&>svg]:size-full">
            {low.from === 'price' ? (
              <MiniDial price={low.prob} timeLeft={0} state="resolved" />
            ) : (
              <MiniDial price={null} model={low.prob} timeLeft={0} state="resolved" />
            )}
          </div>
          <div>
            <p className="font-mono text-13 text-ink tabular-nums">{s.readout[0]}</p>
            <p className="font-mono text-[28px] leading-9 text-ink tabular-nums">{s.readout[1]}</p>
            <p className="text-12 text-ink-muted">{s.readout[2]}</p>
          </div>
        </div>
      )}
      {tape && wide && (
        <figure className={lgOnly ? 'hidden space-y-1 lg:block' : 'space-y-1'} data-story-tape>
          {/* In the sans, 8 px apart: caption and legend share one row at 375 where both fit
              ("MIA @ NYK · NYK to win" and "▲ Horagon model  — Price"), else the legend wraps. */}
          <figcaption className="flex flex-wrap justify-between gap-x-2 text-12 text-ink-muted">
            <span>{tape.caption}</span>
            <span>{tape.legend.join('  ')}</span>
          </figcaption>
          {narrow && (
            <TapeSvg
              tape={narrow}
              box={nbox}
              openedBelow={openedBelow}
              className="sm:hidden"
              id="story-tape-narrow"
            />
          )}
          <TapeSvg
            tape={wide}
            box={WIDE}
            openedBelow={openedBelow}
            className={lgOnly ? 'block' : 'hidden sm:block'}
            id="story-tape-wide"
          />
        </figure>
      )}
      {full && s.line2 && (
        <p
          className={`${lgOnly ? 'hidden ' : ''}${s.tally ? 'mb-0 ' : ''}text-13 text-ink-muted${lgOnly ? ' lg:block' : ''}`}
        >
          {s.line2}
        </p>
      )}
      {full && s.tally && (
        // One row in the sans (263 px for "14 calls · 2 by fans · 12 by the reference agent"),
        // flush between line 2 and the proof: its 44 px link is the row's height and its gap.
        // The link is one atomic box, so "reference agent" never splits across a wrap (§9).
        <p
          className={`${lgOnly ? 'hidden ' : ''}mb-0 text-12 text-ink-muted tabular-nums${lgOnly ? ' lg:block' : ''}`}
          data-tally
        >
          {`${s.tally.parts[0]} · ${s.tally.parts[1]} · ${s.tally.parts[2].slice(0, agentAt)}`}
          <a
            href="/agent"
            className="inline-flex min-h-11 items-center whitespace-nowrap text-ink underline underline-offset-4"
          >
            reference agent
          </a>
        </p>
      )}
      {s.proof.kind === 'pending' ? (
        <p className="text-13 text-ink-muted" data-story-proof={s.proof.kind}>
          {s.proof.text}
        </p>
      ) : (
        // A plain <a>: /verify loads as a new document, with its own CSP (R9).
        <a href={s.proof.href} className={LINK} data-story-proof={s.proof.kind}>
          {`${s.proof.text} `}
          <span aria-hidden="true">→</span>
        </a>
      )}
      {!full && rows && rows.length > 0 && (
        <div className="space-y-2 pt-2" data-last-night-rows>
          <NightRowList rows={rows} />
          <a href="/study" className={LINK}>
            How the model is checked
          </a>
        </div>
      )}
    </section>
  )
}

/**
 * C13, plus the upsets folded inside (fresh-eyes note 1): "5 more games from Wed, Nov 25 · 1
 * upset", so the eyebrow's count is found where the rows are.
 */
function moreGames(rows: readonly LastNightRow[], date: string): string {
  const n = rows.length
  const upsets = rows.filter((r) => r.upset).length
  const games = `${n} more ${n === 1 ? 'game' : 'games'} from ${nightDayLabel(date)}`
  return upsets > 0 ? `${games} · ${upsetCount(upsets)}` : games
}

/**
 * The idle face's foot (§3 S2): below lg it follows the board's list ("How it works" below sm,
 * the A4 rows folded under C13, the Practice line, then C15); from lg it sits under the story in
 * the left column, the A4 rows open.
 */
export function IdleFoot({
  rows,
  date,
  strip,
}: {
  rows: readonly LastNightRow[]
  /** The story night's ET date (YYYY-MM-DD). */
  date: string
  strip: PracticeStripLine | null
}) {
  return (
    <div className="space-y-4">
      <HowItWorks className="sm:hidden" />
      {rows.length > 0 && (
        <>
          <details className="group lg:hidden" data-more-games>
            <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 text-13 text-ink [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="text-ink-muted group-open:rotate-90">
                ▸
              </span>
              {moreGames(rows, date)}
            </summary>
            <div className="space-y-2 pt-1">
              <NightRowList rows={rows} />
              <a href="/study" className={LINK}>
                How the model is checked
              </a>
            </div>
          </details>
          <div className="hidden space-y-2 lg:block" data-last-night-rows>
            <NightRowList rows={rows} />
            <a href="/study" className={LINK}>
              How the model is checked
            </a>
          </div>
        </>
      )}
      <PracticeStrip strip={strip} />
      <p className="flex items-center gap-2 text-13 font-medium text-ink" data-sign-off>
        <span aria-hidden="true" className="h-px w-3.5 flex-none bg-brass-700" />
        {SIGN_OFF}
      </p>
    </div>
  )
}
