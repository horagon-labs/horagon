// API v1 on the server (R5): the Hono app from @horagon/api, built once per server instance and
// shared by the route handler (app/api/v1) and the pages' first frames. A page asks it in
// process, through the same SDK client the browser uses, so the first HTML holds the same data
// the browser's poll would load, with no network hop. Server only: `server-only` (Next's own
// copy, next/dist/compiled/server-only) fails the build if a client component imports this.
import 'server-only'
import { createApp, depsFromEnv } from '@horagon/api'
import {
  etNight,
  type Game,
  type Night,
  type NightGame,
  type PracticeResponse,
  type RecordResponse,
} from '@horagon/sdk'
import { HoragonClient } from '@horagon/sdk/client'
import { isHoragonError } from '@horagon/sdk/errors'
import type { AgentBeat } from '../agent'
import { lookupTarget, type VerifyTarget } from '../verify-target'
import {
  INITIAL_TIMEOUT_MS,
  INITIAL_TTL_MS,
  type InitialBoard,
  type InitialGame,
  loadBoard,
  loadGame,
  loadNight,
  loadRecord,
  RECORD_TTL_MS,
  STORY_TTL_MS,
  ttlCache,
  within,
} from './initial'
import { type LastNight, loadLastNight } from './last-night'
import { storyOfNight } from './story'

let app: ReturnType<typeof createApp> | undefined

/** The Hono app; its deps (DB pool, RPC connection) are built at the first request. */
export function apiApp(): ReturnType<typeof createApp> {
  app ??= createApp(depsFromEnv(process.env))
  return app
}

// The origin is never contacted: requests go straight to the app above.
const INTERNAL = 'http://horagon.internal/api/v1'

let client: HoragonClient | undefined

function serverClient(): HoragonClient {
  client ??= new HoragonClient({
    baseUrl: INTERNAL,
    // One try: the first frame renders without the data rather than wait for a retry.
    retries: 0,
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      return apiApp().fetch(req)
    },
  })
  return client
}

const boards = ttlCache<InitialBoard>(INITIAL_TTL_MS)
const practices = ttlCache<PracticeResponse | null>(INITIAL_TTL_MS)
const games = ttlCache<InitialGame>(INITIAL_TTL_MS)

/** The board's first frame (see lib/server/initial.ts). Never throws. */
export function initialBoard(): Promise<InitialBoard> {
  const now = Math.floor(Date.now() / 1000)
  return boards(
    'board',
    async () => {
      try {
        return await loadBoard(serverClient(), now)
      } catch {
        // depsFromEnv throws without its environment (a local build): no first-frame data.
        return { games: undefined, upcoming: null, now }
      }
    },
    (b) => b.games !== undefined,
  )
}

/** A game page's first frame. Never throws. */
export function initialGame(id: string): Promise<InitialGame> {
  const now = Math.floor(Date.now() / 1000)
  return games(
    `game:${id}`,
    async () => {
      try {
        return await loadGame(serverClient(), id, now)
      } catch {
        return { game: undefined, missing: false, now }
      }
    },
    (g) => g.game !== undefined || g.missing,
  )
}

/**
 * GET /practice for the strip on `/`, /practice and a Practice game's counterparty line (R8).
 * Null with FLAG_PRACTICE off (NOT_FOUND), and when the API failed or was slow. Never throws.
 */
export function initialPractice(): Promise<PracticeResponse | null> {
  return practices(
    'practice',
    async () => {
      try {
        return (await within(serverClient().practice(), INITIAL_TIMEOUT_MS)) ?? null
      } catch {
        return null
      }
    },
    (p) => p !== null,
  )
}

/** One ET game day's games, for its calendar file. Undefined when the API failed or was slow. */
export async function gamesOn(date: string): Promise<Game[] | undefined> {
  try {
    return await within(serverClient().games.list({ date }), INITIAL_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

const targets = ttlCache<VerifyTarget | null | undefined>(INITIAL_TTL_MS)

/**
 * /verify/[market]'s lookup on the server (R6 part B), for its title and first frame. Null when no
 * Horagon market has that address; undefined when the API failed or was slow (the view asks again
 * from the browser). Never throws.
 */
export function verifyTarget(market: string): Promise<VerifyTarget | null | undefined> {
  return targets(
    `verify:${market}`,
    async () => {
      try {
        return await within(lookupTarget(serverClient(), market), INITIAL_TIMEOUT_MS)
      } catch (err) {
        return isHoragonError(err) && (err.code === 'NOT_FOUND' || err.code === 'INVALID_INPUT')
          ? null
          : undefined
      }
    },
    (t) => t !== undefined,
  )
}

/** How long /agent keeps the agent's mode; the agent beats every 20 s. */
const AGENT_TTL_MS = 15_000
/** /health reads the database and the RPC: a little more time than a first frame gets. */
const AGENT_TIMEOUT_MS = 2_500
const agents = ttlCache<AgentBeat | null | undefined>(AGENT_TTL_MS)

/**
 * The reference agent's mode for /agent: GET /health's `agent`, from the agent's own heartbeat.
 * Null when there is no heartbeat; undefined when the API failed or was slow. Either way the page
 * says nothing about the mode. Only an answer is kept. Never throws.
 */
export function initialAgent(): Promise<AgentBeat | null | undefined> {
  return agents(
    'agent',
    async () => {
      try {
        const health = await within(serverClient().health(), AGENT_TIMEOUT_MS)
        return health === undefined ? undefined : (health.agent ?? null)
      } catch {
        return undefined
      }
    },
    (a) => a !== undefined,
  )
}

/** How long / keeps last night's strip. */
const LAST_NIGHT_TTL_MS = 60_000
const lastNights = ttlCache<LastNight | null>(LAST_NIGHT_TTL_MS)

/**
 * "Last night on the dial" for / (R10). Null when there is no such night, or the API was late or
 * failed; only a found night is kept, for 60 s, and per ET night: a page asked for again just after
 * the 06:00 ET rollover (components/tonight-board.tsx) gets the night that has just become last
 * night, not the one before it. Never throws.
 */
export function initialLastNight(): Promise<LastNight | null> {
  const now = Math.floor(Date.now() / 1000)
  return lastNights(
    `last-night:${etNight(now)}`,
    async () => {
      try {
        return await loadLastNight(serverClient(), now)
      } catch {
        return null
      }
    },
    (n) => n !== null,
  )
}

const records = ttlCache<RecordResponse | null>(RECORD_TTL_MS)

/**
 * The proof rail's counts on / (first-screen W6): only an answer is kept, for 60 s. Null when the
 * API failed or was slow. Never throws.
 */
export function initialRecord(): Promise<RecordResponse | null> {
  return records(
    'record',
    async () => {
      try {
        return await loadRecord(serverClient())
      } catch {
        // depsFromEnv throws without its environment (a local build): no counts.
        return null
      }
    },
    (r) => r !== null,
  )
}

const stories = ttlCache<{ night: Night; game: NightGame } | null>(STORY_TTL_MS)

/**
 * The story card's night on / (first-screen W1): GET /nights/{date} for the ET `date`, and the
 * game it tells (`pickStory`). Only a found story is kept, for 10 min. Null when the night has no
 * story, or the API failed or was slower than `timeoutMs` (what is left of the first frame's
 * budget); the card then shows its compact form. Never throws.
 */
export function initialStory(
  date: string,
  timeoutMs = INITIAL_TIMEOUT_MS,
): Promise<{ night: Night; game: NightGame } | null> {
  return stories(
    `story:${date}`,
    async () => {
      try {
        const night = await loadNight(serverClient(), date, timeoutMs)
        return night ? storyOfNight(night) : null
      } catch {
        // depsFromEnv throws without its environment (a local build): no story.
        return null
      }
    },
    (s) => s !== null,
  )
}
