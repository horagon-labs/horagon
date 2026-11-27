// How the reference agent works (R2b), rendered per request: its mode comes from its own
// heartbeat through API v1 (GET /health's `agent`, lib/server/api.ts), so the page states the
// mode only when the agent reported one, and never as a fixed sentence. No client module.
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { AgentView } from '../../components/agent-view'
import { CARD_SIZE } from '../../components/share-card'
import { fullTitle, SITE_NAME } from '../../lib/meta'
import { initialAgent } from '../../lib/server/api'
import { alt as CARD_ALT } from '../opengraph-image'

const TITLE = 'Reference agent'
const DESCRIPTION =
  "How Horagon's disclosed reference agent trades, and why it never counts as a fan."

// This page's openGraph and twitter replace the layout's, file images included, so they name the
// site's card (app/opengraph-image.tsx, app/twitter-image.tsx) themselves: no image route here.
const card = { width: CARD_SIZE.width, height: CARD_SIZE.height, alt: CARD_ALT }

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: fullTitle(TITLE),
    description: DESCRIPTION,
    type: 'website',
    siteName: SITE_NAME,
    images: [{ url: '/opengraph-image', ...card }],
  },
  twitter: {
    title: fullTitle(TITLE),
    description: DESCRIPTION,
    card: 'summary_large_image',
    images: [{ url: '/twitter-image', ...card }],
  },
}

export default async function AgentPage() {
  await connection()
  return <AgentView beat={await initialAgent()} />
}
