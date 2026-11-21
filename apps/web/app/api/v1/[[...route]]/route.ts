// API v1 as a Vercel Node function: the Hono app from @horagon/api, built once per instance.
// force-dynamic: nothing here runs at build time, so the build opens no DB or RPC connection.
import { createApp, depsFromEnv } from '@horagon/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

let app: ReturnType<typeof createApp> | undefined

function handler(req: Request): Response | Promise<Response> {
  app ??= createApp(depsFromEnv(process.env))
  return app.fetch(req)
}

export { handler as GET, handler as OPTIONS, handler as POST }
