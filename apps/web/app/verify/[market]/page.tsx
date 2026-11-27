// /verify/[market] (R6 part B): check a result against the chain, in the viewer's browser. This
// shell looks the market's game up once (the title, and the view's first frame); the view reads
// the GameMarket account from a public RPC and the evidence from the URI on chain. It reads only
// public data and adds no API route, so it is not behind FLAG_VERIFY. Nothing on / imports it.
import type { Metadata } from 'next'
import { connection } from 'next/server'
import { VerifyView } from '../../../components/verify-view'
import { fullTitle, verifyMeta } from '../../../lib/meta'
import { verifyTarget } from '../../../lib/server/api'

type Props = { params: Promise<{ market: string }> }

/** A base58 Solana address, or null: anything else never reaches the API. */
function marketOf(raw: string): string | null {
  const m = decodeURIComponent(raw)
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m) ? m : null
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const market = marketOf((await params).market)
  await connection()
  const target = market ? await verifyTarget(market) : null
  const m = verifyMeta(target ?? undefined)
  const shared = { title: fullTitle(m.title), description: m.description }
  return {
    title: m.title,
    description: m.description,
    openGraph: { ...shared, type: 'website', siteName: 'Horagon' },
    twitter: { ...shared, card: 'summary_large_image' },
  }
}

export default async function VerifyPage({ params }: Props) {
  const market = marketOf((await params).market)
  await connection()
  // The same cached lookup as the metadata above: one API call for both.
  const target = market ? await verifyTarget(market) : null
  return <VerifyView market={market} initial={target} />
}
