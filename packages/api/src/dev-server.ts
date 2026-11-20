// Local API on :8787 against the env in the shell (Supabase or a local Postgres, devnet or
// Surfpool). The web app proxies /api/v1 here in development.
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { depsFromEnv } from './config'

const app = createApp(depsFromEnv(process.env))
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) => {
  console.log(`horagon api on http://localhost:${info.port}/api/v1`)
})
