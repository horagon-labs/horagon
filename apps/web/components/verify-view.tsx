'use client'
// /verify/[market] (R6 part B): one row per check with both values in full, one verdict line, and
// the command that hashes the evidence by hand. The checks (lib/verify.ts, with web3.js for the
// program addresses) load only once this view runs, so the page's first load stays small.
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { DISABLED } from '../lib/chrono/controls'
import { etClock } from '../lib/chrono/time'
import { PUBLIC_RPC } from '../lib/format'
import type { VerifyResult } from '../lib/verify'
import { lookupTarget, type VerifyTarget } from '../lib/verify-target'

const LINK = 'text-ink underline underline-offset-4'
const BUTTON = `min-h-11 rounded-card border border-rule px-4 text-13 font-semibold text-ink ${DISABLED}`

/** "2026-11-29 02:05 UTC · 9:05 PM ET". */
const both = (ts: number) =>
  `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${etClock(ts)}`

function statusLine(r: VerifyResult): string | null {
  switch (r.status) {
    case 'proposed':
      return r.windowEndsAt === null
        ? 'Proposed on chain'
        : `Proposed on chain · the challenge window ends ${both(r.windowEndsAt)}`
    case 'finalized':
    case 'recycled':
      return 'Final on chain'
    case 'challenged':
      return 'Under review on chain'
    case 'open':
    case 'halted':
      return 'Not proposed yet'
    default:
      return null
  }
}

/** Fetches bytes for the evidence check; a non-2xx answer counts as no answer. */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export function VerifyView(p: {
  /** The market in the URL, or null when it is not a Solana address. */
  market: string | null
  /** The server's lookup: null for no such market, undefined when it could not ask. */
  initial: VerifyTarget | null | undefined
}) {
  const [target, setTarget] = useState(p.initial)
  const [lookupFailed, setLookupFailed] = useState(false)
  const [endpoint, setEndpoint] = useState(PUBLIC_RPC)
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [running, setRunning] = useState(false)
  const [rpcError, setRpcError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const runId = useRef(0)

  const run = useCallback(async (t: VerifyTarget, rpc: string) => {
    const id = ++runId.current
    setRunning(true)
    setRpcError(null)
    try {
      const { rpcAccount, verifyMarket } = await import('../lib/verify')
      const r = await verifyMarket(
        { account: (address) => rpcAccount(fetch, rpc, address), fetchBytes },
        {
          market: t.resolution.market,
          gameMarket: t.resolution.gameMarket,
          evidenceUrl: t.resolution.evidenceUrl,
        },
      )
      if (id === runId.current) setResult(r)
    } catch (err) {
      if (id !== runId.current) return
      setResult(null)
      setRpcError(err instanceof Error ? err.message : 'no answer')
    } finally {
      if (id === runId.current) setRunning(false)
    }
  }, [])

  // The server could not look the market up: ask once from the browser.
  useEffect(() => {
    if (target !== undefined || !p.market) return
    lookupTarget(api, p.market)
      .then(setTarget)
      .catch(() => setLookupFailed(true))
  }, [target, p.market])

  // The first check runs on its own, against the default RPC.
  const started = useRef(false)
  useEffect(() => {
    if (!target || started.current) return
    started.current = true
    void run(target, PUBLIC_RPC)
  }, [target, run])

  if (!p.market || target === null) {
    return (
      <section className="space-y-4 py-6">
        <h1 className="text-19 font-semibold text-ink">Verify result</h1>
        <p className="text-15 text-ink">No Horagon market has this address.</p>
        <Link href="/" className={LINK}>
          Back to tonight's games
        </Link>
      </section>
    )
  }

  const status = result ? statusLine(result) : null
  return (
    <section className="mx-auto max-w-3xl space-y-5 py-2">
      <header className="space-y-1">
        <h1 className="text-19 font-semibold text-ink">
          Verify result{target ? ` · ${target.away} @ ${target.home}` : ''}
        </h1>
        {target && (
          <p className="text-13">
            <Link href={`/game/${target.gameId}`} className={LINK}>
              Back to the game
            </Link>
          </p>
        )}
        <p className="text-13 text-ink-muted">
          Every check runs in this browser. The account comes from the Solana RPC below, the
          evidence from the address stored on chain, and each value is shown in full.
        </p>
      </header>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (target) void run(target, endpoint.trim())
        }}
      >
        <label className="min-w-0 flex-1 space-y-1">
          <span className="block text-12 text-ink-muted">Solana RPC</span>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            inputMode="url"
            spellCheck={false}
            className="min-h-11 w-full rounded-card border border-rule bg-surface-raised px-3 font-mono text-13 text-ink outline-none focus:border-ink"
          />
        </label>
        <button type="submit" disabled={!target || running} className={BUTTON}>
          Check again
        </button>
      </form>

      {lookupFailed && !target && (
        <p className="text-13 text-error">
          The market could not be looked up. Reload the page to ask again.
        </p>
      )}
      {(running || (!target && !lookupFailed)) && (
        <p role="status" className="text-13 text-ink-muted">
          Reading the chain…
        </p>
      )}
      {rpcError && (
        <p className="text-13 text-error">
          The RPC did not answer ({rpcError}). Paste another endpoint and check again.
        </p>
      )}

      {result && (
        <>
          {status && <p className="text-13 text-ink">{status}</p>}
          <ol className="space-y-3">
            {result.checks.map((c) => (
              <li
                key={c.id}
                className="space-y-2 rounded-card border border-rule-faint bg-surface-raised p-3"
                data-check={c.id}
                data-ok={c.ok}
              >
                <p className="flex items-baseline gap-2 text-13 font-semibold text-ink">
                  <span className={c.ok ? 'text-ink' : 'text-error'}>
                    {c.ok ? '✓ Pass' : '✗ Fail'}
                  </span>
                  <span>{c.label}</span>
                </p>
                <dl className="space-y-1">
                  {c.values.map((v) => (
                    <div key={v.name}>
                      <dt className="text-12 text-ink-muted">{v.name}</dt>
                      <dd className="break-all font-mono text-12 text-ink">{v.value}</dd>
                    </div>
                  ))}
                </dl>
                {c.note && <p className="text-12 text-ink-muted">{c.note}</p>}
              </li>
            ))}
          </ol>
          <p
            aria-live="polite"
            className={`text-15 font-semibold ${result.verdict.kind === 'fail' ? 'text-error' : 'text-ink'}`}
            data-verdict
          >
            {result.verdict.text}
          </p>
          {result.curl && (
            <div className="space-y-2">
              <p className="text-13 text-ink-muted">Hash it yourself:</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-card border border-rule-faint bg-surface-sunk px-3 py-2 font-mono text-12 text-ink">
                  {result.curl}
                </code>
                <button
                  type="button"
                  className={BUTTON}
                  onClick={() => {
                    const line = result.curl
                    if (!line) return
                    navigator.clipboard?.writeText(line).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    )
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
