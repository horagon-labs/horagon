// Tonight (Chronometer spec 4.1, R5): the hero and the live board. Rendered per request, so the
// first HTML holds tonight's games (lib/server/api.ts); the board then polls in the browser.
// Under the board, one static line discloses the reference agent (R2b). With FLAG_PRACTICE on,
// the Practice strip (R8) sits under the board, or is the hero's second line on a rest day.
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AgentNote } from '../components/chrono/agent-line'
import { Hero } from '../components/chrono/hero'
import { PracticeStrip } from '../components/chrono/practice-strip'
import { TonightBoard } from '../components/tonight-board'
import { practiceStrip } from '../lib/chrono/practice'
import { isTonight } from '../lib/format'
import { HOME_TITLE, SITE_DESCRIPTION } from '../lib/meta'
import { initialBoard, initialPractice } from '../lib/server/api'

export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: HOME_TITLE,
    description: SITE_DESCRIPTION,
    type: 'website',
    siteName: 'Horagon',
  },
  twitter: { title: HOME_TITLE, description: SITE_DESCRIPTION, card: 'summary_large_image' },
}

export default async function TonightPage() {
  // Per request: the board's data is live, and the build opens no DB or RPC connection.
  await connection()
  const [initial, practice] = await Promise.all([initialBoard(), initialPractice()])
  const strip = practiceStrip(practice, initial.now)
  const rest =
    initial.games !== undefined && !initial.games.some((g) => isTonight(g, initial.now * 1000))
  return (
    <>
      <Hero second={rest ? <PracticeStrip strip={strip} /> : undefined} />
      <TonightBoard initial={initial} />
      {!rest && <PracticeStrip strip={strip} className="mt-6" />}
      <AgentNote />
    </>
  )
}
