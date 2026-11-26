// API v1 as a Vercel Node function: the Hono app from @horagon/api, built once per instance and
// shared with the pages' first frames (lib/server/api.ts).
// force-dynamic: nothing here runs at build time, so the build opens no DB or RPC connection.
import { apiApp } from '../../../../lib/server/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function handler(req: Request): Response | Promise<Response> {
  return apiApp().fetch(req)
}

export { handler as GET, handler as OPTIONS, handler as POST }
