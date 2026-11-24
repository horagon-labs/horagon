import type { Metadata, Viewport } from 'next'
import { JetBrains_Mono, Space_Grotesk } from 'next/font/google'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ChronoMotion } from '../components/chrono/motion'
import { Wordmark } from '../components/chrono/wordmark'
import { PlayMoneyBanner } from '../components/play-money-banner'
import { WalletProvider } from '../components/wallet'
import { WalletButton } from '../components/wallet-button'
import './globals.css'

// Self-hosted at build time, so no layout shift (spec 2.2).
const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-grotesk', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' })

export const metadata: Metadata = {
  title: 'Horagon: game-day NBA markets',
  description: 'Play-money in-game NBA prediction markets on Solana devnet.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark',
  themeColor: '#07090b',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${grotesk.variable} ${mono.variable}`}>
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
