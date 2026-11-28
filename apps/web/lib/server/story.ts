// The first screen's story (first-screen spec W1): which game of a night the idle face tells, its
// words (C7, C8, C8t, C11, C12) and the tape's geometry (C10, G1). Pure, from GET /nights/{date}
// (told from the winner's side). Server only: the story card renders on the server, so none of
// this reaches a client chunk.
import 'server-only'
import type { Night, NightGame, NightLow, NightPoint } from '@horagon/sdk'
import { proposedLine } from '../chrono/copy'
import { COMEBACK_MAX, type Story } from '../chrono/story'
import { periodLabel } from '../chrono/tape'
import { percent } from '../format'

/** Culture review string 19: the result is not on chain yet. */
export const STORY_PENDING =
  'The result goes on-chain after a box-score check. The morning read is ready at 6:00 AM ET.'

/** Whose model the ▲ and the dashed line are (fresh-eyes note 2). */
export const HORAGON_MODEL = 'Horagon model'

/** The % a reader sees: ties on it go to the upset. */
const shown = (p: number) => Math.round(p * 100)

/**
 * The game the idle face tells (G8): a moved market first, then the lowest winner chance, a tie
 * on the shown % going to the upset, then the exact chance, then tip-off. Null on an empty night.
 */
export function pickStory(night: Night): NightGame | null {
  const order = (a: NightGame, b: NightGame): number => {
    if (a.moved !== b.moved) return a.moved ? -1 : 1
    const la = a.low?.prob ?? Number.POSITIVE_INFINITY
    const lb = b.low?.prob ?? Number.POSITIVE_INFINITY
    if (Number.isFinite(la) && Number.isFinite(lb) && shown(la) !== shown(lb)) {
      return shown(la) - shown(lb)
    }
    if (Number.isFinite(la) !== Number.isFinite(lb)) return Number.isFinite(la) ? -1 : 1
    if (a.upset !== b.upset) return a.upset ? -1 : 1
    if (la !== lb) return la - lb
    return Date.parse(a.scheduledTipoff) - Date.parse(b.scheduledTipoff)
  }
  return [...night.games].sort(order)[0] ?? null
}

/** A night and the game its story tells; null when the night has none. */
export function storyOfNight(night: Night): { night: Night; game: NightGame } | null {
  const game = pickStory(night)
  return game ? { night, game } : null
}

const mmss = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

/** "Q3 5:41", or "Q3" with no clock. */
const clockAt = (l: Pick<NightLow, 'period' | 'clockSecs'>) =>
  l.clockSecs === null ? periodLabel(l.period) : `${periodLabel(l.period)} ${mmss(l.clockSecs)}`

/** The period a time falls in, from the period starts (1 before the first). */
function periodAt(g: NightGame, t: number): number {
  const n = g.periodStarts.filter((s) => s <= t).length
  return Math.max(1, n)
}

/** The model's low and its period: the low itself on a flat night, else the model line's lowest. */
function modelLow(g: NightGame): { prob: number; period: number } | null {
  if (g.low?.from === 'model') return { prob: g.low.prob, period: g.low.period }
  let best: NightPoint | undefined
  for (const p of g.model) if (!best || p[1] < best[1]) best = p
  return best ? { prob: best[1], period: periodAt(g, best[0]) } : null
}

export interface StoryProof {
  /** final: string 20; proposed: the challenge countdown; challenged; pending: string 19. */
  kind: 'final' | 'proposed' | 'challenged' | 'pending'
  text: string
  /** The result's page, /verify/{market}. */
  href: string
}

export interface StoryLines {
  /** R8's StoryPlate word: Upset, then Comeback, then Overtime, in that order of priority. */
  plate: Story | null
  /** C7. */
  line1: string
  /** C8: the buzzer price once moved; else the model low, only while the winner trailed. */
  line2: string | null
  /** C8t, moved only: "14 calls · 2 by fans · 12 by the reference agent". */
  tally: { parts: [string, string, string]; text: string } | null
  /**
   * C11 (desktop): "Low point · Q3 5:41 · 63–74", "MIN to win 7%", then "Horagon model" or
   * "price".
   */
  readout: [string, string, string] | null
  /** C12. */
  proof: StoryProof
  /** The story says the price moved: the hero may then say so (C2b). */
  moved: boolean
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function proofOf(g: NightGame, now: number): StoryProof {
  const href = `/verify/${g.market}`
  switch (g.resolution.status) {
    case 'finalized':
    case 'recycled':
      return { kind: 'final', text: `Result on-chain · ${g.winner} won · Check it yourself`, href }
    case 'proposed':
      return { kind: 'proposed', text: proposedLine(g.resolution.challengeEndsAt, now), href }
    case 'challenged':
      return { kind: 'challenged', text: 'Result under review', href }
    default:
      return { kind: 'pending', text: STORY_PENDING, href }
  }
}

/** The story card's words for one game of the night; `now` (unix seconds) times a countdown. */
export function storyLines(g: NightGame, now: number): StoryLines {
  const score = `${g.winner} won ${Math.max(g.homeScore, g.awayScore)}–${Math.min(g.homeScore, g.awayScore)}`
  const model = modelLow(g)
  const plate: Story | null = g.upset
    ? 'Upset'
    : model && model.prob <= COMEBACK_MAX
      ? 'Comeback'
      : g.overtime
        ? 'Overtime'
        : null
  const line1 =
    plate === 'Upset'
      ? `${score} from ${percent(g.openedBps / 10_000)} before tip-off`
      : plate === 'Comeback' && model
        ? `${score} after the model had them at ${percent(model.prob)} in ${periodLabel(model.period)}`
        : plate === 'Overtime'
          ? `${score} in overtime`
          : score

  const low = g.low
  const down = low ? `${low.winnerScore}–${low.loserScore}` : ''
  let line2: string | null = null
  if (g.moved && g.closed !== null) {
    line2 = `At the buzzer the price had ${g.winner} at ${percent(g.closed)}.`
  } else if (low && low.from === 'model' && low.winnerScore < low.loserScore) {
    line2 = `The model had ${g.winner} at ${percent(low.prob)} at ${clockAt(low)}, down ${down}.`
  }

  const calls = g.calls.fans + g.calls.agent + g.calls.others
  const parts: [string, string, string] = [
    plural(calls, 'call', 'calls'),
    g.calls.fans === 1 ? '1 by a fan' : `${g.calls.fans} by fans`,
    `${g.calls.agent} by the reference agent`,
  ]
  return {
    plate,
    line1,
    line2,
    tally: g.moved ? { parts, text: parts.join(' · ') } : null,
    // "Low point" over the big number, so beside "MIN won" it reads as the game's low, not the
    // result; and the model named as Horagon's (fresh-eyes notes 8 and 2).
    readout: low
      ? [
          `Low point · ${clockAt(low)} · ${down}`,
          `${g.winner} to win ${percent(low.prob)}`,
          low.from === 'model' ? HORAGON_MODEL : 'price',
        ]
      : null,
    proof: proofOf(g, now),
    moved: g.moved,
  }
}

export interface TapeMark {
  x: number
  y: number
  label: string
}

export interface Tape {
  /** The model line's path (`d`), dashed by the card; empty without points. */
  model: string
  /** The price line's path, for a moved game only. */
  price: string | null
  /** x of each period start after the first: a quarter rule each. */
  rules: number[]
  /** Each period's label, at the middle of its span. */
  periods: Array<{ x: number; label: string }>
  /** The winner's opening price, at the left edge. */
  opened: TapeMark
  /** Where the ring rests (G1): the low, with its %. */
  low: TapeMark | null
  /** The end of the model line, with the final score. */
  final: TapeMark
  /** "MIN @ OKC · MIN to win"; the legend says which lines are drawn. */
  caption: string
  legend: string[]
}

export interface TapeBox {
  w: number
  h: number
  pad?: { top: number; right: number; bottom: number; left: number }
}

const r1 = (v: number) => Math.round(v * 10) / 10

const pathOf = (points: Array<[number, number]>) =>
  points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${r1(x)},${r1(y)}`).join('')

/**
 * The tape's geometry in viewBox units (C10, G1): time runs from tip-off (the first period start)
 * to the first Final snapshot, the winner's chance from 0 at the bottom to 1 at the top, inside
 * `pad`. The price line starts at its value at tip-off. The card draws and labels it.
 */
export function tapeModel(g: NightGame, box: TapeBox): Tape {
  const pad = box.pad ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const left = pad.left
  const right = box.w - pad.right
  const top = pad.top
  const bottom = box.h - pad.bottom
  const t0 = g.periodStarts[0] ?? g.model[0]?.[0] ?? 0
  const end = g.model.at(-1)?.[0] ?? t0
  const t1 = end > t0 ? end : t0 + 1
  const x = (t: number) =>
    left + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (right - left)
  const y = (p: number) => top + (1 - p) * (bottom - top)

  let price: string | null = null
  if (g.moved) {
    const before = g.price.filter(([t]) => t < t0).at(-1)
    const inside = g.price.filter(([t]) => t >= t0 && t <= t1)
    const line: NightPoint[] = before ? [[t0, before[1]], ...inside] : inside
    price = line.length > 0 ? pathOf(line.map(([t, p]) => [x(t), y(p)])) : null
  }

  const starts = g.periodStarts.length > 0 ? g.periodStarts : [t0]
  const periods = starts.map((s, i) => ({
    x: r1((x(s) + x(starts[i + 1] ?? t1)) / 2),
    label: periodLabel(i + 1),
  }))
  const last = g.model.at(-1)
  const ws = Math.max(g.homeScore, g.awayScore)
  const ls = Math.min(g.homeScore, g.awayScore)
  return {
    model: pathOf(g.model.map(([t, p]) => [x(t), y(p)])),
    price,
    rules: starts.slice(1).map((s) => r1(x(s))),
    periods,
    opened: {
      x: left,
      y: r1(y(g.openedBps / 10_000)),
      label: `opened ${percent(g.openedBps / 10_000)}`,
    },
    low: g.low ? { x: r1(x(g.low.ts)), y: r1(y(g.low.prob)), label: percent(g.low.prob) } : null,
    final: { x: right, y: r1(y(last ? last[1] : 1)), label: `Final ${ws}–${ls}` },
    // The legend names the lines, the model as Horagon's (fresh-eyes note 2): the first "model" a
    // reader meets at 375. The caption no longer repeats it, so both still share one row there.
    caption: `${g.away} @ ${g.home} · ${g.winner} to win`,
    legend: g.moved ? [`▲ ${HORAGON_MODEL}`, '— Price'] : [`▲ ${HORAGON_MODEL}`],
  }
}
