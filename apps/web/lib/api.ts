// The one API client of the web app: same-origin API v1 (app/api/v1), never RPC. The page's
// connect-src follows the same base (lib/csp.ts).
import { HoragonClient } from '@horagon/sdk/client'
import { API_BASE } from './csp'

export const api = new HoragonClient({
  baseUrl: API_BASE,
  retries: 1,
})
