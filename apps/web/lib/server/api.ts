// API v1 on the server (R5): the Hono app from @horagon/api, built once per server instance and
// shared by the route handler (app/api/v1) and the pages' first frames. A page asks it in
// process, through the same SDK client the browser uses, so the first HTML holds the same data
// the browser's poll would load, with no network hop. Server only: `server-only` (Next's own
// copy, next/dist/compiled/server-only) fails the build if a client component imports this.
import 'server-only'
import { createApp, depsFromEnv } from '@horagon/api'
import type { Game } from '@horagon/sdk'
import { HoragonClient } from '@horagon/sdk/client'
import {
  INITIAL_TIMEOUT_MS,
  INITIAL_TTL_MS,
  type InitialBoard,
  type InitialGame,
  loadBoard,
  loadGame,
  ttlCache,
  within,
} from './initial'

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

/** One ET game day's games, for its calendar file. Undefined when the API failed or was slow. */
export async function gamesOn(date: string): Promise<Game[] | undefined> {
  try {
    return await within(serverClient().games.list({ date }), INITIAL_TIMEOUT_MS)
  } catch {
    return undefined
  }
}
