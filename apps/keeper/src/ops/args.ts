// Pure helpers for `horagon-ops`, kept apart from the CLI glue so they are unit tested.
import { errorSignature, errorSummary } from '@horagon/sdk'
import { PublicKey } from '@solana/web3.js'
import { checkBoxScoreUrl } from '../evidence'
import { ProgramFailure, UnresolvedAttempt } from '../executor'

/**
 * argv without a leading `--`: pnpm 10.10 passes the separator of `pnpm … ops -- status`
 * through, and `parseArgs` would read everything after it as positionals.
 */
export function stripArgSeparator(argv: readonly string[]): string[] {
  return argv[0] === '--' ? argv.slice(1) : [...argv]
}

/** A real league date, YYYY-MM-DD; `name` is the flag or argument named in the error. */
export function gameDateArg(raw: string | undefined, name: string): string {
  const ok =
    raw !== undefined &&
    /^\d{4}-\d{2}-\d{2}$/.test(raw) &&
    !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) &&
    new Date(`${raw}T00:00:00Z`).toISOString().startsWith(raw)
  if (!ok) throw new Error(`${name} must be a real date, YYYY-MM-DD, got "${raw ?? ''}"`)
  return raw
}

/**
 * The postponement notice for `propose --postponed`: https, no credentials, no port other than
 * the default, at most 256 characters once normalised. Returns the normalised href to store.
 */
export function noticeUrl(raw: string | undefined): string {
  let url: URL
  try {
    url = new URL((raw ?? '').trim())
  } catch {
    throw new Error('--notice must be an https URL')
  }
  if (url.protocol !== 'https:') throw new Error('--notice must be an https URL')
  if (url.username || url.password) throw new Error('--notice must not carry credentials')
  if (url.port) throw new Error('--notice must not set a port')
  if (url.href.length > 256) throw new Error('--notice must be at most 256 characters')
  return url.href
}

/** The box score for `propose`: `checkBoxScoreUrl`, with the normalised href to store. */
export function boxScoreUrl(raw: string | undefined): {
  url: string
  source: string
  warning?: string
} {
  const check = checkBoxScoreUrl((raw ?? '').trim())
  if (!check.ok) throw new Error(`--box-score: ${check.reason}`)
  const url = check.url ?? new URL((raw ?? '').trim()).href
  return check.warning
    ? { url, source: check.source, warning: check.warning }
    : { url, source: check.source }
}

/** The program's bounds (MIN/MAX_DISPUTE_WINDOW_SECS): 60 s to 7 days; 900 s when omitted. */
export function disputeWindowArg(raw: string | undefined): number {
  if (raw === undefined) return 900
  const secs = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN
  if (!(secs >= 60 && secs <= 604_800))
    throw new Error(`--window must be whole seconds from 60 to 604800, got "${raw}"`)
  return secs
}

/** A base58 public key; the error names the argument, not the value. */
export function publicKeyArg(name: string, raw: string | undefined): PublicKey {
  try {
    return new PublicKey(raw ?? '')
  } catch {
    throw new Error(`${name} is not a public key`)
  }
}

const SIGNATURE = /\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/

/**
 * What `horagon-ops` prints for an error, and its exit code. An UnresolvedAttempt is "unknown",
 * never retried here (exit 3); anything else is an error (exit 1). A ProgramFailure is never
 * read as "already done". Messages go through `errorSummary`, so RPC keys are cut.
 */
export function opsErrorReport(err: unknown): { lines: string[]; exitCode: number } {
  const message = errorSummary(err).message
  if (err instanceof UnresolvedAttempt) {
    const sig = SIGNATURE.exec(message)?.[0]
    return {
      exitCode: 3,
      lines: [
        `unknown: ${message}`,
        ...(sig ? [`signature: ${sig}`] : []),
        'The transaction may still land and was not retried. Run `horagon-ops status` (and look the signature up) before running this command again.',
      ],
    }
  }
  const sig = errorSignature(err)
  const lines = [`error: ${message}`, ...(sig ? [`signature: ${sig}`] : [])]
  if (err instanceof ProgramFailure)
    lines.push('The program rejected the transaction. Check `horagon-ops status` before retrying.')
  return { exitCode: 1, lines }
}

/** "112-108" (home-away) to [112, 108]. */
export function parseScore(raw: string): [number, number] {
  const m = /^(\d{1,3})-(\d{1,3})$/.exec(raw.trim())
  if (!m) throw new Error(`--score must look like 112-108 (home-away), got "${raw}"`)
  return [Number(m[1]), Number(m[2])]
}

/** "30-25,28-27,26-30,27-24" (home-away per period, OT included). */
export function parsePeriods(raw: string): Array<[number, number]> {
  const periods = raw.split(',').map((p) => {
    try {
      return parseScore(p)
    } catch {
      throw new Error(`--periods must look like 30-25,28-27,26-30,27-24 (home-away), got "${raw}"`)
    }
  })
  if (periods.length < 4 || periods.length > 12) throw new Error('--periods needs 4 to 12 periods')
  return periods
}

const SOL_AMOUNT = /^(0|[1-9]\d{0,2})(\.\d{1,9})?$/

/** A SOL amount (plain decimal, at most 9 decimals) to lamports, refusing silly amounts. */
export function solToLamports(raw: string, max = 10): number {
  if (!Number.isFinite(max) || max <= 0) throw new Error('max must be a finite positive SOL amount')
  if (!SOL_AMOUNT.test(raw))
    throw new Error(`amount must be a plain decimal SOL with at most 9 decimals, got "${raw}"`)
  const [whole = '0', fraction = ''] = raw.split('.')
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))
  if (lamports <= 0n || lamports > BigInt(Math.floor(max * 1e9)))
    throw new Error(`amount must be in (0, ${max}] SOL`)
  return Number(lamports)
}

/** Whether a keeper heartbeat this old should page, given the games around now (spec 7). */
export function heartbeatStale(
  ageSecs: number | null,
  tipoffs: readonly number[],
  nowSecs: number,
  maxAgeSecs = 120,
): boolean {
  const gameNight = tipoffs.some((t) => nowSecs >= t - 90 * 60 && nowSecs <= t + 4 * 3600)
  return gameNight && (ageSecs === null || ageSecs > maxAgeSecs)
}
