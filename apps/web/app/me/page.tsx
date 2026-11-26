// My Game-day (R7): tonight's calls of this browser's play wallet, scored against the model,
// with the wallet's key block open. The wallet lives in the browser, so the page renders there.
import type { Metadata } from 'next'
import { MeView } from '../../components/me-view'

export const metadata: Metadata = {
  title: 'My Game-day',
  robots: { index: false },
}

export default function MePage() {
  return <MeView />
}
