// Tonight (Chronometer spec 4.1, R5; first-screen spec §3, §7): the hero, the proof rail (W6) and
// the live board. Rendered per request, so the first HTML holds tonight's games, the record's
// counts and the story of the newest final night (lib/server/api.ts); the board then polls in the
// browser.
// While no market is open (S1 rest, S2 later, S5 after), the story card is the board's idle face,
// in the dial's slot, and its foot holds the night's other games (A4), the Practice line (R8) and
// the sign-off. While a Practice run is on (S6, over S1/S2/S5) the Practice card leads the idle
// face and the story is compact below lg; between runs the foot keeps R8's one line. Once a market
// is open (S3, S4) the Night dial keeps the slot, and the compact story and the Practice line
// follow the board; the board gets both, so a market opening under its poll swaps them with no
// reload. Last, one static line discloses the reference agent, only while its claim shows (W9).
// Which of these shows is one pure decision, `firstScreen` (lib/server/first-screen.ts); this file
// loads the data and renders what it picks.
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AgentNote } from '../components/chrono/agent-line'
import { Hero, HowItWorks } from '../components/chrono/hero'
import { PracticeCard } from '../components/chrono/practice-card'
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
import { agentNoteHolds, firstScreen, storyNight } from '../lib/server/first-screen'
import { INITIAL_TIMEOUT_MS } from '../lib/server/initial'
import { rowsOfNight } from '../lib/server/last-night'

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
  // The story under what is left of the budget, for the night it tells (S5: the night that just
  // ended; otherwise the newest final night before it). On a miss the night's strip stands in.
  const told = storyNight(initial.games, initial.now, lastNight)
  const story = told
    ? await initialStory(
        told.date,
        Math.max(STORY_FLOOR_MS, INITIAL_TIMEOUT_MS - (Date.now() - started)),
      )
    : null
  const screen = firstScreen({ games: initial.games, now: initial.now, lastNight, story, practice })
  const { night } = screen
  const rows = story ? rowsOfNight(story.night, story.game.id) : []
  const strip = practiceStrip(practice, initial.now)
  // S6: the run on the court leads the idle face (never with FLAG_PRACTICE off).
  const lead =
    screen.lead && practice ? (
      <PracticeCard run={screen.lead} counterparty={practice.counterparty} />
    ) : undefined
  const face =
    screen.face === 'story' && story ? (
      <StoryCard story={story} now={initial.now} variant={screen.compact ? 'lg-full' : 'full'} />
    ) : screen.face === 'strip' && night ? (
      <LastNightStrip night={night} now={initial.now} className="" />
    ) : undefined
  // While a run leads, the foot drops the strip's own "Practice game live" line.
  const foot =
    screen.idle && night ? (
      <IdleFoot rows={rows} date={night.date} strip={screen.compact ? null : strip} />
    ) : undefined
  // W9: the agent note only while its claim shows (agent calls on the story night, or a listed
  // market moved tonight).
  const agentNote = agentNoteHolds(initial.games, initial.now, story?.night)
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
        state={screen.state}
        idleLead={lead}
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
      {agentNote && <AgentNote />}
    </>
  )
}
