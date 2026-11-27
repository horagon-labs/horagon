// Tonight (Chronometer spec 4.1, R5; first-screen spec §3, §7): the hero, the proof rail (W6) and
// the live board. Rendered per request, so the first HTML holds tonight's games, the record's
// counts and the story of the newest final night (lib/server/api.ts); the board then polls in the
// browser.
// While no market is open (S1 rest, S2 later, S5 after), the story card is the board's idle face,
// in the dial's slot, and its foot holds the night's other games (A4), the Practice line (R8) and
// the sign-off. Once a market is open (S3, S4) the Night dial keeps the slot, and the compact story
// and the Practice line follow the board; the board gets both, so a market opening under its poll
// swaps them with no reload. Last, one static line discloses the reference agent.
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AgentNote } from '../components/chrono/agent-line'
import { Hero, HowItWorks } from '../components/chrono/hero'
import { PracticeStrip } from '../components/chrono/practice-strip'
import { LastNightStrip } from '../components/last-night'
import { ProofRail } from '../components/proof-rail'
import { IdleFoot, StoryCard } from '../components/story-card'
import { TonightBoard } from '../components/tonight-board'
import { heroMoved } from '../lib/chrono/board'
import { practiceStrip } from '../lib/chrono/practice'
import { HOME_TITLE, SITE_DESCRIPTION } from '../lib/meta'
import {
  initialBoard,
  initialLastNight,
  initialPractice,
  initialRecord,
  initialStory,
} from '../lib/server/api'
import { idleState, screenState } from '../lib/server/first-screen'
import { INITIAL_TIMEOUT_MS } from '../lib/server/initial'
import { currentNight, rowsOfNight } from '../lib/server/last-night'

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

/** The story's own wait when the first four used the whole first-frame budget. */
const STORY_FLOOR_MS = 200

export default async function TonightPage() {
  // Per request: the board's data is live, and the build opens no DB or RPC connection.
  await connection()
  const started = Date.now()
  // All four under the first frame's one cap, side by side.
  const [initial, lastNight, practice, record] = await Promise.all([
    initialBoard(),
    initialLastNight(),
    initialPractice(),
    initialRecord(),
  ])
  const state = screenState(initial.games, initial.now)
  // S5: the night that just ended tells the story; otherwise the newest final night before it.
  const night = (state === 'after' && currentNight(initial.games ?? [], initial.now)) || lastNight
  // The story under what is left of the budget; on a miss the night's strip stands in.
  const story = night
    ? await initialStory(
        night.date,
        Math.max(STORY_FLOOR_MS, INITIAL_TIMEOUT_MS - (Date.now() - started)),
      )
    : null
  const rows = story ? rowsOfNight(story.night, story.game.id) : []
  const strip = practiceStrip(practice, initial.now)
  const idle = idleState(state) && night !== null
  const face = !idle ? undefined : story ? (
    <StoryCard story={story} now={initial.now} />
  ) : night ? (
    <LastNightStrip night={night} now={initial.now} className="" />
  ) : undefined
  const foot = idle && night ? <IdleFoot rows={rows} date={night.date} strip={strip} /> : undefined
  return (
    <>
      <Hero moved={heroMoved(initial.games, initial.now, story?.game.moved ?? false)} />
      <ProofRail
        record={record}
        proofMarket={story?.game.market ?? night?.rows[0]?.market ?? null}
      />
      {/* The open foot follows the board whenever no idle face shows: S3/S4 (or no night to
          tell) from the first frame, and S1/S2 once the poll sees the first market open (G4).
          "How it works" under the board at 375, the compact story, then the Practice line. */}
      <TonightBoard
        initial={initial}
        idleFace={face}
        idleFoot={foot}
        openFoot={
          <>
            <HowItWorks className="mt-4 sm:hidden" />
            {story ? (
              <div className="mt-8">
                <StoryCard story={story} now={initial.now} variant="compact" rows={rows} />
              </div>
            ) : (
              night && <LastNightStrip night={night} now={initial.now} />
            )}
            <PracticeStrip strip={strip} className="mt-6" />
          </>
        }
      />
      <AgentNote />
    </>
  )
}
