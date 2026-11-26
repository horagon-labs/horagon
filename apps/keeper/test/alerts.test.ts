import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { PERSON_ALERT_SECS, personAlertWindow, telegramAlerter } from '../src/alerts'

const log = pino({ level: 'silent' })

/** A Telegram alerter on a fake clock; `keys` lists every key that reached the network. */
function alerter(opts: { dedupeFor?: (key: string) => number | undefined; ok?: () => boolean }) {
  const clock = { t: 1_000 }
  const keys: string[] = []
  let sending = ''
  const a = telegramAlerter({
    token: 'T',
    chatId: '42',
    log,
    now: () => clock.t,
    ...(opts.dedupeFor ? { dedupeFor: opts.dedupeFor } : {}),
    fetchImpl: (async () => {
      keys.push(sending)
      return new Response('{}', { status: (opts.ok?.() ?? true) ? 200 : 502 })
    }) as unknown as typeof fetch,
  })
  return {
    clock,
    keys,
    send: (key: string) => {
      sending = key
      return a.send(key, 'text')
    },
  }
}

describe('personAlertWindow', () => {
  it('gives the alerts that need a person 3 h, by prefix', () => {
    for (const key of [
      'stuck:nba-1',
      'periods:nba-1',
      'tie:nba-1',
      'treasury-unread',
      'decode:nba-1',
      'index-stuck:Mkt1',
      'index-skip:Mkt1',
      'archive',
      'tick-failing',
      'index-failing',
      'evidence-mismatch:nba-1',
      'source-held:nba-1',
    ]) {
      expect(personAlertWindow(key), key).toBe(PERSON_ALERT_SECS)
    }
    expect(PERSON_ALERT_SECS).toBe(10_800)
  })

  it('leaves every other key to the default window', () => {
    for (const key of [
      'halt:nba-1',
      'challenge:nba-1:1',
      'draft:nba-1:0',
      'unconfirmed:nba-1:0',
      'source-mismatch:nba-1',
      'auto-proposed:nba-1:0',
      'auto-propose-off',
      'treasury-low',
      'tx:create nba-1',
      'archived',
      'stuckish:nba-1',
      'tick-failing-soon',
    ]) {
      expect(personAlertWindow(key), key).toBeUndefined()
    }
  })
})

describe('telegramAlerter dedupeFor', () => {
  it('uses the per-key window when dedupeFor answers, else dedupeSecs', async () => {
    const a = alerter({ dedupeFor: personAlertWindow })
    await a.send('stuck:nba-1')
    await a.send('halt:nba-1')
    a.clock.t += 601
    await a.send('stuck:nba-1')
    await a.send('halt:nba-1')
    expect(a.keys).toEqual(['stuck:nba-1', 'halt:nba-1', 'halt:nba-1'])
    a.clock.t += PERSON_ALERT_SECS - 601
    await a.send('stuck:nba-1')
    expect(a.keys.at(-1)).toBe('stuck:nba-1')
    expect(a.keys).toHaveLength(4)
  })

  it('keeps the 600 s default without dedupeFor', async () => {
    const a = alerter({})
    await a.send('stuck:nba-1')
    a.clock.t += 599
    await a.send('stuck:nba-1')
    a.clock.t += 1
    await a.send('stuck:nba-1')
    expect(a.keys).toEqual(['stuck:nba-1', 'stuck:nba-1'])
  })

  it('still re-arms a long-window key 60 s after a failed delivery', async () => {
    let ok = false
    const a = alerter({ dedupeFor: personAlertWindow, ok: () => ok })
    await a.send('archive')
    a.clock.t += 59
    await a.send('archive')
    expect(a.keys).toHaveLength(1)
    a.clock.t += 1
    ok = true
    await a.send('archive')
    expect(a.keys).toHaveLength(2)
    // Delivered now: the 3 h window holds.
    a.clock.t += 3_600
    await a.send('archive')
    expect(a.keys).toHaveLength(2)
  })
})

describe('telegramAlerter delivery', () => {
  it('says whether the message reached Telegram, until the key is tried again', async () => {
    let up = false
    const a = alerter({ ok: () => up })
    expect(await a.send('auto-proposed:nba-1:0')).toBe(false)
    // Within the 60 s before a retry, nothing is sent and the message is still not delivered.
    a.clock.t += 30
    expect(await a.send('auto-proposed:nba-1:0')).toBe(false)
    up = true
    a.clock.t += 30
    expect(await a.send('auto-proposed:nba-1:0')).toBe(true)
    // A repeat of a delivered key is dropped as delivered.
    a.clock.t += 5
    expect(await a.send('auto-proposed:nba-1:0')).toBe(true)
    expect(a.keys).toEqual(['auto-proposed:nba-1:0', 'auto-proposed:nba-1:0'])
  })
})
