import type { Metadata, Viewport } from 'next'
import { JetBrains_Mono, Space_Grotesk } from 'next/font/google'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ChronoMotion } from '../components/chrono/motion'
import { Wordmark } from '../components/chrono/wordmark'
import { PlayMoneyBanner } from '../components/play-money-banner'
import { WalletProvider } from '../components/wallet'
import { WalletButton } from '../components/wallet-button'
import { COLORS } from '../lib/chrono/tokens'
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, siteUrl } from '../lib/meta'
import './globals.css'

// Self-hosted at build time, so no layout shift (spec 2.2).
const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-grotesk', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' })

export const metadata: Metadata = {
  // Absolute share links (og:image, og:url) on the public site; localhost in a local build, and
  // Next's own default in a production build without HORAGON_PUBLIC_URL.
  metadataBase: siteUrl(process.env.HORAGON_PUBLIC_URL),
  title: { default: SITE_TITLE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: SITE_TITLE, description: SITE_DESCRIPTION },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Light only (light branding review §4.9); the browser bar runs into the white header.
  colorScheme: 'only light',
  themeColor: COLORS['enamel-900'],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`}>
      <body className="min-h-dvh pb-14">
        <ChronoMotion>
          <WalletProvider>
            <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between gap-3 border-b border-brass-500/15 bg-enamel-950/90 px-4 py-1.5 backdrop-blur">
              <Link
                href="/"
                aria-label="Horagon, tonight's games"
                className="flex min-h-11 items-center"
              >
                <Wordmark />
              </Link>
              <WalletButton />
            </header>
            <main className="mx-auto max-w-6xl px-4 py-4">{children}</main>
            <PlayMoneyBanner />
          </WalletProvider>
        </ChronoMotion>
      </body>
    </html>
  )
}
