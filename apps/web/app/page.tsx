// Tonight (Chronometer spec 4.1, R5): the hero and the live board. Rendered per request, so the
// first HTML holds tonight's games (lib/server/api.ts); the board then polls in the browser.
// Under the board: with FLAG_PRACTICE on, the Practice strip (R8), which is the hero's second
// line on a rest day instead; then last night's games (R10, A4); then one static line discloses
// the reference agent (R2b).
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AgentNote } from '../components/chrono/agent-line'
import { Hero } from '../components/chrono/hero'
import { PracticeStrip } from '../components/chrono/practice-strip'
import { LastNightStrip } from '../components/last-night'
import { TonightBoard } from '../components/tonight-board'
import { practiceStrip } from '../lib/chrono/practice'
import { isTonight } from '../lib/format'
import { HOME_TITLE, SITE_DESCRIPTION } from '../lib/meta'
import { initialBoard, initialLastNight, initialPractice } from '../lib/server/api'

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
  // All three under the first frame's one cap, side by side.
  const [initial, lastNight, practice] = await Promise.all([
    initialBoard(),
    initialLastNight(),
    initialPractice(),
  ])
  const strip = practiceStrip(practice, initial.now)
  const rest =
    initial.games !== undefined && !initial.games.some((g) => isTonight(g, initial.now * 1000))
  return (
    <>
      <Hero second={rest ? <PracticeStrip strip={strip} /> : undefined} />
      <TonightBoard initial={initial} />
      {!rest && <PracticeStrip strip={strip} className="mt-6" />}
      {lastNight && <LastNightStrip night={lastNight} />}
      <AgentNote />
    </>
  )
}
