'use client'
// What app/error.tsx and app/global-error.tsx show (light branding review §4.12): the mark on paper,
// SOMETHING_WRONG and a way to try again. Never the error's own words: a stack, a chunk name or an
// RPC URL means nothing to a player.
import { STOPPED_MARK } from '../lib/icons'
import { SOMETHING_WRONG } from '../lib/wallet-copy'
import { DialMark } from './chrono/dial-mark'

export function ErrorPage(p: { retry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-4 py-12 text-center">
      <DialMark size={96} {...STOPPED_MARK} className="size-24" />
      <p className="text-15">{SOMETHING_WRONG}</p>
      <button
        type="button"
        onClick={() => p.retry()}
        className="min-h-11 rounded-card bg-ivory-100 px-6 text-15 font-semibold text-enamel-950"
      >
        Try again
      </button>
    </div>
  )
}
