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
