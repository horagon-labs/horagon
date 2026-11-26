'use client'
// The error page when the root layout itself failed (light branding review §4.12). It replaces the
// whole document, so it draws its own <html> and <body> on paper, loads the stylesheet and keeps
// the play-money banner, as the layout does.
import { ErrorPage } from '../components/error-page'
import { PlayMoneyBanner } from '../components/play-money-banner'
import './globals.css'

export default function GlobalError(p: { error: unknown; retry: () => void; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-enamel-950 pb-14 text-ivory-100">
        <main className="mx-auto max-w-6xl px-4 py-4">
          <ErrorPage retry={p.retry} />
        </main>
        <PlayMoneyBanner />
      </body>
    </html>
  )
}
