// The 404 (light branding review §4.12, culture A3 keeps its own copy for later): the mark on paper,
// "No game here" and the way back, inside the root layout, so the header and the play-money banner
// are there too and Next's own page (which turns black on a dark OS) never shows.
import Link from 'next/link'
import { DialMark } from '../components/chrono/dial-mark'
import { STOPPED_MARK } from '../lib/icons'

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <DialMark size={96} {...STOPPED_MARK} className="size-24" />
      <h1 className="text-19 font-semibold">No game here</h1>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center text-15 underline underline-offset-4"
      >
        Back to tonight's games
      </Link>
    </div>
  )
}
