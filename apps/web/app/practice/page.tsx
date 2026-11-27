// /practice (R8): the Practice run in flight, else when the next one tips off. Rendered on the
// server per request from GET /practice: a run on the court (or about to tip off, or just
// finished) redirects to its game page; otherwise the next tip-off in ET and string 26. With
// FLAG_PRACTICE off, or the API down, it is the 404 page. Ships no script of its own.
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { connection } from 'next/server'
import { PracticePlate } from '../../components/chrono/practice-plate'
import { PRACTICE_LINE, practicePage } from '../../lib/chrono/practice'
import { initialPractice } from '../../lib/server/api'

export const metadata: Metadata = {
  title: 'Practice',
  description: `${PRACTICE_LINE}. A recorded NBA game replayed on Solana devnet, every 2 hours.`,
}

export default async function PracticePage() {
  await connection()
  const view = practicePage(await initialPractice(), Math.floor(Date.now() / 1000))
  if (!view) notFound()
  if ('redirect' in view) redirect(view.redirect)
  return (
    <section className="flex flex-col items-center gap-4 py-12 text-center" data-practice-page>
      <PracticePlate />
      <h1 className="text-19 font-semibold text-ink">{view.line}</h1>
      <p className="text-14 text-ink-muted">{PRACTICE_LINE}</p>
      <Link href="/" className="text-14 text-ink underline underline-offset-4">
        Back to tonight&apos;s games
      </Link>
    </section>
  )
}
