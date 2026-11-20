// The one API client of the web app: same-origin API v1 (app/api/v1), never RPC.
import { HoragonClient } from '@horagon/sdk/client'

export const api = new HoragonClient({
  baseUrl: process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1',
  retries: 1,
})
