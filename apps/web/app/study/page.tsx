// How the model is checked (R10): the mechanism study, from the snapshot the study script writes
// (apps/keeper/scripts/study.ts) and the controller commits after each night. A static page: the
// JSON is imported at build, so a render reaches no RPC and no DB; the schema check
// fails the build on a bad snapshot.
import { StudySnapshotSchema } from '@horagon/sdk/study'
import type { Metadata } from 'next'
import { CARD_SIZE } from '../../components/share-card'
import { STUDY_TITLE, StudyView } from '../../components/study-view'
import snapshot from '../../content/study.json'
import { fullTitle, SITE_NAME } from '../../lib/meta'
import { alt as CARD_ALT } from '../opengraph-image'

const DESCRIPTION =
  "Horagon's pre-game model is written on chain before every game. Here it is scored against the results."

// As on /agent: this page's openGraph and twitter replace the layout's, so they name the site's
// card themselves.
const card = { width: CARD_SIZE.width, height: CARD_SIZE.height, alt: CARD_ALT }

export const metadata: Metadata = {
  title: STUDY_TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: fullTitle(STUDY_TITLE),
    description: DESCRIPTION,
    type: 'website',
    siteName: SITE_NAME,
    images: [{ url: '/opengraph-image', ...card }],
  },
  twitter: {
    title: fullTitle(STUDY_TITLE),
    description: DESCRIPTION,
    card: 'summary_large_image',
    images: [{ url: '/twitter-image', ...card }],
  },
}

const study = StudySnapshotSchema.parse(snapshot)

export default function StudyPage() {
  return <StudyView snapshot={study} />
}
