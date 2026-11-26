// Always on screen (spec section 2, legal): fixed to the bottom of every page. Chronometer
// changes its look only, never its words (spec 2.7): a solid white band under a brass hairline,
// ink 13/600, so nothing scrolls through it (light branding review §4.1). The words are
// PLAY_MONEY_NOTICE from the SDK, the one copy of the line (the crown sheet, OG images and bot
// messages use it too).
import { PLAY_MONEY_NOTICE } from '@horagon/sdk/notice'

export function PlayMoneyBanner() {
  return (
    <div
      role="note"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-brass-700 bg-enamel-900 px-4 py-2 text-center text-13 font-semibold text-ivory-100"
    >
      {PLAY_MONEY_NOTICE}
    </div>
  )
}
