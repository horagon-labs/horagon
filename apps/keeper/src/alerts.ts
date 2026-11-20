// Telegram alerts (spec 7), deduplicated per key so a condition that holds for an hour sends
// one message, not 720. Sending never throws: a Telegram outage must not stop the keeper.
import type { Logger } from 'pino'

export interface Alerter {
  /** Sends unless the same key was sent within the dedupe window. */
  send(key: string, text: string): Promise<void>
}

export interface TelegramOptions {
  token: string
  chatId: string
  log: Logger
  /** Same key again within this window is dropped (default 10 min). */
  dedupeSecs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  /** Prefixed to every message, e.g. "[devnet]". */
  prefix?: string
}

export function telegramAlerter(opts: TelegramOptions): Alerter {
  const sent = new Map<string, number>()
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => Date.now() / 1000)
  const window = opts.dedupeSecs ?? 600
  const url = `https://api.telegram.org/bot${opts.token}/sendMessage`
  return {
    async send(key, text) {
      const t = now()
      const last = sent.get(key)
      if (last !== undefined && t - last < window) return
      sent.set(key, t)
      const body = { chat_id: opts.chatId, text: opts.prefix ? `${opts.prefix} ${text}` : text }
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) opts.log.warn({ key, status: res.status }, 'telegram rejected the alert')
      } catch (err) {
        // The error may carry the URL, which holds the bot token: log the name only.
        opts.log.warn({ key, error: (err as Error).name }, 'telegram unreachable')
      }
      opts.log.info({ key, alert: text }, 'alert')
    },
  }
}

/** For local runs without Telegram: the alert only goes to the log. */
export function logAlerter(log: Logger): Alerter {
  return {
    async send(key, text) {
      log.warn({ key, alert: text }, 'alert')
    },
  }
}
