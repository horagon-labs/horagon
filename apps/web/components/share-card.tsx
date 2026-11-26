// The link-preview image (R5), drawn by next/og (Satori): a dial-like gauge with the price, the
// matchup, the score or the tip-off and the play-money line, in the brand palette. Satori takes
// inline styles only, and every element with more than one child is a flex box.
import { PLAY_MONEY_NOTICE } from '@horagon/sdk/notice'
import { arcPath, MAX_ANGLE, MIN_ANGLE, polar, priceToAngle } from '../lib/chrono/geometry'
import { COLORS } from '../lib/chrono/tokens'

export const CARD_SIZE = { width: 1200, height: 630 }

const C = 100
const TICKS = [0, 0.25, 0.5, 0.75, 1]

/**
 * The gauge: the 270-degree scale, an arc up to the price and the needle, lume while the price is
 * a live chance and ash once trading stopped; no arc and no needle without a price.
 */
export function ShareGauge(p: { price: number | null; size: number; live?: boolean }) {
  const { price, size } = p
  const tone = p.live === false ? COLORS['ash-400'] : COLORS['lume-300']
  const angle = price === null ? null : priceToAngle(price)
  const tip = angle === null ? null : polar(C, C, 68, angle)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      role="img"
      aria-label="Price gauge"
      data-gauge
    >
      <circle
        cx={C}
        cy={C}
        r={94}
        fill={COLORS['enamel-800']}
        stroke={COLORS['brass-500']}
        strokeWidth={3}
      />
      <path
        d={arcPath(C, C, 80, MIN_ANGLE, MAX_ANGLE)}
        fill="none"
        stroke={COLORS.line}
        strokeWidth={10}
        strokeLinecap="round"
      />
      {angle !== null && (
        <path
          d={arcPath(C, C, 80, MIN_ANGLE, angle)}
          fill="none"
          stroke={tone}
          strokeWidth={10}
          strokeLinecap="round"
          data-arc
        />
      )}
      {TICKS.map((t) => {
        const a = polar(C, C, 62, priceToAngle(t))
        const b = polar(C, C, 70, priceToAngle(t))
        return (
          <line
            key={t}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={COLORS['ash-400']}
            strokeWidth={2}
          />
        )
      })}
      {tip && (
        <line
          x1={C}
          y1={C}
          x2={tip.x}
          y2={tip.y}
          stroke={tone}
          strokeWidth={5}
          strokeLinecap="round"
          data-needle
        />
      )}
      <circle cx={C} cy={C} r={8} fill={COLORS['brass-500']} />
    </svg>
  )
}

export interface ShareCardProps {
  /** "LAC @ MEM", or the site's name on the home card. */
  title: string
  /** The score or the tip-off; the hero line on the home card. */
  line: string
  /** "MEM to win · 62%"; none on the home card. */
  headline?: string
  price: number | null
  /** False once trading stopped: the needle and the headline turn from lume to ash and ivory. */
  live?: boolean
}

export function ShareCard(p: ShareCardProps) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 48,
        padding: '48px 56px',
        background: COLORS['enamel-950'],
        border: `6px solid ${COLORS['brass-700']}`,
        color: COLORS['ivory-100'],
        fontFamily: 'sans-serif',
      }}
    >
      <ShareGauge price={p.price} size={380} live={p.live} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 16 }}>
        <div style={{ fontSize: 26, letterSpacing: 10, color: COLORS['brass-500'] }}>HORAGON</div>
        <div style={{ fontSize: 72, lineHeight: 1.05 }}>{p.title}</div>
        <div style={{ fontSize: 30, color: COLORS['ash-400'], lineHeight: 1.3 }}>{p.line}</div>
        {p.headline && (
          <div
            style={{
              fontSize: 48,
              color: p.live === false ? COLORS['ivory-100'] : COLORS['lume-300'],
              lineHeight: 1.15,
            }}
          >
            {p.headline}
          </div>
        )}
        {/* The play-money line in the one look it has everywhere (light branding review §4.1). */}
        <div
          style={{
            fontSize: 24,
            fontWeight: 600,
            color: COLORS['ivory-100'],
            background: COLORS['enamel-900'],
            borderTop: `2px solid ${COLORS['brass-700']}`,
            padding: '10px 16px',
            marginTop: 16,
          }}
        >
          {PLAY_MONEY_NOTICE}
        </div>
      </div>
    </div>
  )
}
