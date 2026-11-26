'use client'
// Share a game (R5): the system share sheet, or the link copied, or the link shown to copy.
import { useEffect, useState } from 'react'
import { type ShareResult, shareAction, shareEnv, shareLabel } from '../lib/share'

const RESET_MS = 2_500

export function ShareButton({ title, text }: { title: string; text: string }) {
  const [result, setResult] = useState<ShareResult | null>(null)
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (result !== 'copied') return
    const t = setTimeout(() => setResult(null), RESET_MS)
    return () => clearTimeout(t)
  }, [result])

  async function onClick() {
    const href = window.location.href
    setUrl(href)
    setResult(await shareAction(shareEnv(navigator), { title, text, url: href }))
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void onClick()}
        className="min-h-11 rounded-full border border-line px-4 text-13 text-ivory-100 hover:border-brass-500"
        data-share
      >
        <span aria-hidden="true">↗ </span>
        {shareLabel(result)}
      </button>
      <span role="status" className="text-12 text-ash-400">
        {result === 'failed' && (
          <>
            Copy this link: <span className="select-all font-mono">{url}</span>
          </>
        )}
      </span>
    </div>
  )
}
