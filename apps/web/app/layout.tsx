import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { PlayMoneyBanner } from '../components/play-money-banner'
import { WalletProvider } from '../components/wallet'
import { WalletButton } from '../components/wallet-button'
import './globals.css'

export const metadata: Metadata = {
  title: 'Horagon: game-day NBA markets',
  description: 'Play-money in-game NBA prediction markets on Solana devnet.',
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh pb-14">
        <WalletProvider>
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 bg-zinc-50/90 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
            <Link href="/" className="text-lg font-bold">
              Horagon
            </Link>
            <WalletButton />
          </header>
          <main className="mx-auto max-w-2xl px-4 py-4">{children}</main>
          <PlayMoneyBanner />
        </WalletProvider>
      </body>
    </html>
  )
}
