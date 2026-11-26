// Always on screen (spec section 2, legal): fixed to the bottom of every page. Chronometer
// changes its look only, never its words (spec 2.7). The words are PLAY_MONEY_NOTICE from the
// SDK, the one copy of the line (the crown sheet, OG images and bot messages use it too).
import { PLAY_MONEY_NOTICE } from '@horagon/sdk/notice'

export function PlayMoneyBanner() {
  return (
    <div
      role="note"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-amber-400/40 bg-enamel-950/95 px-4 py-2 text-center text-13 font-semibold text-amber-400"
    >
      {PLAY_MONEY_NOTICE}
    </div>
  )
}
