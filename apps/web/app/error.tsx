'use client'
// The error page inside the root layout (light branding review §4.12): light like every other page,
// under the same header and over the same play-money banner, so Next's own page (which turns
// black on a dark OS) never shows.
import { ErrorPage } from '../components/error-page'

export default function RouteError(p: { error: unknown; retry: () => void; reset: () => void }) {
  return <ErrorPage retry={p.retry} />
}
