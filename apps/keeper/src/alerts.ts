// Telegram alerts (spec 7), deduplicated per key so a condition that holds for an hour sends
// one message, not 720. Sending never throws: a Telegram outage must not stop the keeper.
import type { Logger } from 'pino'

export interface Alerter {
  /**
   * Sends unless the same key was sent within the dedupe window. False when the message did not
   * reach the chat (yet): the caller may call again, and the alerter retries after a pause. An
   * alerter that cannot tell returns nothing, which counts as delivered.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: an alerter written as `async () => {}` stays one
  send(key: string, text: string): Promise<boolean | void>
}

export interface TelegramOptions {
  token: string
  chatId: string
  log: Logger
  /** Same key again within this window is dropped (default 10 min). */
  dedupeSecs?: number
  /**
   * A window for one key: a number replaces `dedupeSecs` for that key, undefined keeps it. Must
   * be a pure function of the key (`personAlertWindow` for the keeper and ops).
   */
  dedupeFor?: (key: string) => number | undefined
  fetchImpl?: typeof fetch
  now?: () => number
  /** Prefixed to every message, e.g. "[devnet]". */
  prefix?: string
}

/** After a failed delivery the same key may be sent again after this long. */
const RETRY_AFTER_FAILURE_SECS = 60

/** The window of the alerts that need a person: a repeat every 10 min would only be noise. */
export const PERSON_ALERT_SECS = 10_800

/**
 * Keys (exact, or as `<key>:…`) whose condition waits on a person: resolve by hand, fix the
 * feed or the RPC, read a decode error. Every other key keeps the alerter's default window.
 */
const PERSON_ALERT_KEYS = [
  'stuck',
  'periods',
  'tie',
  'treasury-unread',
  'decode',
  'index-stuck',
  'index-skip',
  'ata-trace',
  'archive',
  'tick-failing',
  'index-failing',
  'index-rate-limited',
  'index-failover',
  'evidence-mismatch',
  'source-held',
  'second-source-refused',
] as const

/** `dedupeFor` for the keeper and ops: 3 h for the keys that need a person, else the default. */
export function personAlertWindow(key: string): number | undefined {
  const person = PERSON_ALERT_KEYS.some((k) => key === k || key.startsWith(`${k}:`))
  return person ? PERSON_ALERT_SECS : undefined
}

export function telegramAlerter(opts: TelegramOptions): Alerter {
  const sent = new Map<string, number>()
  /** Keys whose last message did not reach Telegram. */
  const failed = new Set<string>()
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now() / 1000)
  const defaultWindow = opts.dedupeSecs ?? 600
  const url = `https://api.telegram.org/bot${opts.token}/sendMessage`
  return {
    async send(key, text) {
      const t = now()
      const window = opts.dedupeFor?.(key) ?? defaultWindow
      const last = sent.get(key)
      if (last !== undefined && t - last < window) return !failed.has(key)
      sent.set(key, t)
      let delivered = false
      const body = { chat_id: opts.chatId, text: opts.prefix ? `${opts.prefix} ${text}` : text }
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })
        delivered = res.ok
        if (!res.ok) opts.log.warn({ key, status: res.status }, 'telegram rejected the alert')
      } catch (err) {
        // The error may carry the URL, which holds the bot token: log the name only.
        opts.log.warn({ key, error: (err as Error).name }, 'telegram unreachable')
      }
      // A failed delivery must not silence the key for the whole window, nor retry on every call.
      if (!delivered) sent.set(key, t - window + Math.min(RETRY_AFTER_FAILURE_SECS, window))
      if (delivered) failed.delete(key)
      else failed.add(key)
      opts.log.info({ key, alert: text }, 'alert')
      return delivered
    },
  }
}

/** For local runs without Telegram: the alert only goes to the log. */
export function logAlerter(log: Logger): Alerter {
  return {
    async send(key, text) {
      log.warn({ key, alert: text }, 'alert')
      return true
    },
  }
}
