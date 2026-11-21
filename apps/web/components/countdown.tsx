'use client'
import { effectiveTime } from '@horagon/sdk'
import { useEffect, useState } from 'react'
import { countdown } from '../lib/format'

/**
 * Time left until `end_ts`, when the market stops trading (spec 6.1). `chainTs` is the latest
 * chain time the page has seen (the last price point): a clock behind it is moved up to it, as
 * every quote and live state does (`effectiveTime`).
 */
export function Countdown({ endTs, chainTs }: { endTs: number; chainTs: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1_000)
    return () => clearInterval(t)
  }, [])
  return (
    <p className="text-sm text-zinc-500">
      Trading closes in{' '}
      <span className="font-mono text-zinc-900 dark:text-zinc-100">
        {countdown(endTs, effectiveTime(now, chainTs))}
      </span>
    </p>
  )
}
