// Dev-only gallery of every Chronometer state, for the screenshots of spec 6.2 when no live
// market is in that state. A production build answers 404 here.
import { notFound } from 'next/navigation'
import { Gallery } from '../../../components/chrono/gallery'

export default function ChronoGalleryPage() {
  if (process.env.NODE_ENV === 'production') notFound()
  return <Gallery />
}
