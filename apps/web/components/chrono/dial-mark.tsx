// The dial mark (app/icon.svg): a brass bezel, a lume needle at two thirds of the scale and a
// brass hub. The wordmark, the apple touch icon and the share card all draw this one shape.
export const MARK_NEEDLE = 'M16 16 L22.5 9.5'

export function DialMark(p: {
  size: number
  face: string
  ring: string
  needle: string
  className?: string
}) {
  return (
    <svg
      width={p.size}
      height={p.size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={p.className}
      data-mark
    >
      <circle cx={16} cy={16} r={14.5} fill={p.face} stroke={p.ring} strokeWidth={2} />
      <path d={MARK_NEEDLE} stroke={p.needle} strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={16} cy={16} r={2.5} fill={p.ring} />
    </svg>
  )
}

/**
 * A home-screen icon (R5): the dial mark on the enamel, filling 82% of a `px` square. Drawn by
 * next/og (Satori: inline styles, a flex box) for the apple touch icon and the manifest's PNGs.
 */
export function HomeIcon(p: {
  px: number
  colors: Record<'bg' | 'face' | 'ring' | 'needle', string>
}) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: p.colors.bg,
      }}
      data-home-icon={p.px}
    >
      <DialMark
        size={Math.round(p.px * 0.82)}
        face={p.colors.face}
        ring={p.colors.ring}
        needle={p.colors.needle}
      />
    </div>
  )
}
