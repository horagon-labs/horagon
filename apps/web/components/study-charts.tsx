// The two charts of /study (R10), as inline SVG drawn on the server: no chart library, no script.
// Semantic tokens only (ink, ink-muted, rule, brass); brass marks the median Final, the clock's
// own metal, as the buzzer index does on the dial. Text is 12 px at the widest scale.
import type { StudySnapshot } from '@horagon/sdk/study'

const W = 340
const H = 200
const PAD = { left: 34, right: 10, top: 24, bottom: 34 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom
const SVG = 'h-auto w-full max-w-md font-mono'
const TEXT = { fontSize: 12 }

function yTicks(max: number, step: number): number[] {
  const out: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

/** Price move of a 100 mUSDC buy at 50% against minutes after tip-off, both end_ts offsets. */
export function DepthChart({ depth }: { depth: StudySnapshot['depth'] }) {
  const maxMinute = Math.max(...depth.curves.map((c) => c.endOffsetSecs / 60))
  const moves = depth.curves.flatMap((c) => c.points.map((p) => p.move100 ?? 0))
  const yMax = Math.max(0.1, Math.ceil(Math.max(...moves) * 10) / 10)
  const x = (minute: number) => PAD.left + (minute / maxMinute) * PLOT_W
  const y = (move: number) => PAD.top + PLOT_H - (move / yMax) * PLOT_H
  const [today, before] = depth.curves
  const path = (c: (typeof depth.curves)[number] | undefined) =>
    (c?.points ?? [])
      .filter((p) => p.move100 !== null)
      .map(
        (p, i) => `${i === 0 ? 'M' : 'L'}${x(p.minute).toFixed(1)},${y(p.move100 ?? 0).toFixed(1)}`,
      )
      .join(' ')
  const median = x(depth.medianFinalMinutes)
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={SVG}
      role="img"
      aria-label="Price move of a 100 mUSDC buy at 50%, by minutes after tip-off: it grows as end_ts nears, faster with the earlier end_ts."
    >
      {yTicks(yMax, 0.1).map((v) => (
        <g key={v}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(v)}
            y2={y(v)}
            className="stroke-rule"
            strokeWidth={0.5}
            strokeDasharray="1 3"
          />
          <text x={PAD.left - 4} y={y(v) + 4} textAnchor="end" className="fill-ink-muted" {...TEXT}>
            {Math.round(v * 100)}
          </text>
        </g>
      ))}
      {[0, 60, 120, 180].map((m) => (
        <text
          key={m}
          x={x(m)}
          y={H - PAD.bottom + 16}
          textAnchor="middle"
          className="fill-ink-muted"
          {...TEXT}
        >
          {m}
        </text>
      ))}
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={y(0)}
        y2={y(0)}
        className="stroke-rule"
        strokeWidth={1}
      />
      <line
        x1={median}
        x2={median}
        y1={PAD.top - 6}
        y2={y(0)}
        className="stroke-brass"
        strokeWidth={1.5}
        data-median-final
      />
      <text
        x={Math.min(median, W - PAD.right - 44)}
        y={PAD.top - 10}
        textAnchor="middle"
        className="fill-ink-muted"
        {...TEXT}
      >
        median Final
      </text>
      <path
        d={path(before)}
        fill="none"
        className="stroke-ink-muted"
        strokeWidth={1.5}
        strokeDasharray="5 3"
      />
      <path d={path(today)} fill="none" className="stroke-ink" strokeWidth={2} />
      <text
        x={PAD.left + PLOT_W / 2}
        y={H - 4}
        textAnchor="middle"
        className="fill-ink-muted"
        {...TEXT}
      >
        minutes after tip-off
      </text>
    </svg>
  )
}

/** Simulated loss per sixth of the market's life, against the even-rate prediction. */
export function LossChart({ sim }: { sim: StudySnapshot['lpSim'] }) {
  const n = sim.buckets.length
  const top = Math.max(...sim.buckets.map((b) => Math.max(b.loss, b.predicted)))
  const yMax = Math.ceil((top * 100) / 5) * 0.05
  const y = (v: number) => PAD.top + PLOT_H - (v / yMax) * PLOT_H
  const slot = PLOT_W / Math.max(1, n)
  const predicted = sim.buckets[0]?.predicted ?? 0
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={SVG}
      role="img"
      aria-label="Simulated loss in each sixth of the market's life: every bar sits near the even-rate line."
    >
      {yTicks(yMax, 0.05).map((v) => (
        <text
          key={v}
          x={PAD.left - 4}
          y={y(v) + 4}
          textAnchor="end"
          className="fill-ink-muted"
          {...TEXT}
        >
          {Math.round(v * 100)}
        </text>
      ))}
      {sim.buckets.map((b, i) => (
        <rect
          key={b.from}
          x={PAD.left + i * slot + slot * 0.2}
          width={slot * 0.6}
          y={y(b.loss)}
          height={y(0) - y(b.loss)}
          className="fill-rule"
          data-bucket
        />
      ))}
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={y(0)}
        y2={y(0)}
        className="stroke-rule"
        strokeWidth={1}
      />
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={y(predicted)}
        y2={y(predicted)}
        className="stroke-ink"
        strokeWidth={1.5}
        strokeDasharray="5 3"
      />
      <text x={PAD.left} y={H - PAD.bottom + 16} className="fill-ink-muted" {...TEXT}>
        open
      </text>
      <text
        x={W - PAD.right}
        y={H - PAD.bottom + 16}
        textAnchor="end"
        className="fill-ink-muted"
        {...TEXT}
      >
        end_ts
      </text>
      <text
        x={PAD.left + PLOT_W / 2}
        y={H - 4}
        textAnchor="middle"
        className="fill-ink-muted"
        {...TEXT}
      >
        sixths of the market&apos;s life
      </text>
    </svg>
  )
}
