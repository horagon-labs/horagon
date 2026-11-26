// The wordmark (spec 2.7, R5): "HORAGON" in ink 15/600 (its brass-named class paints ink, review
// §3.3), spaced wide, after the dial mark of the icon: white face, brass case, live needle, ink hub.
import { MARK_COLORS } from '../../lib/icons'
import { DialMark } from './dial-mark'

export function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-brass-500">
      <DialMark size={20} {...MARK_COLORS} className="size-5" />
      <span className="text-15 font-semibold tracking-[0.35em]">HORAGON</span>
    </span>
  )
}
