// The wordmark (spec 2.7, R5): "HORAGON" in brass, spaced wide, after the dial mark of the icon.
import { COLORS } from '../../lib/chrono/tokens'
import { DialMark } from './dial-mark'

export function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-brass-500">
      <DialMark
        size={20}
        face={COLORS['enamel-800']}
        ring="currentColor"
        needle={COLORS['lume-300']}
        className="size-5"
      />
      <span className="text-15 font-semibold tracking-[0.35em]">HORAGON</span>
    </span>
  )
}
