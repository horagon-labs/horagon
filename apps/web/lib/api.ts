// The one API client of the web app: same-origin API v1 (app/api/v1), never RPC. The page's
// connect-src follows the same base (lib/csp.ts).
import { HoragonClient } from '@horagon/sdk/client'
import { API_BASE } from './csp'

export const api = new HoragonClient({
  baseUrl: API_BASE,
  retries: 1,
})

/**
 * The board's poll (first-screen G4): the same base and requests as `api`, but each tick asks the
 * server before using the browser's copy (a 304 keeps it). `/games` answers `s-maxage=1,
 * stale-while-revalidate=5` for the edge, and a browser honours the stale-while-revalidate too:
 * each 3 s tick would show the answer fetched in the background one tick earlier, so a market
 * opening would swap the idle face for the Night dial a poll late.
 */
export const boardApi = new HoragonClient({
  baseUrl: API_BASE,
  retries: 1,
  cache: 'no-cache',
})
