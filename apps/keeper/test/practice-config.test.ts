// R8: the Practice process's own settings, read beside the keeper's (config.ts is not edited).
import { describe, expect, it } from 'vitest'
import { PERSON_ALERT_SECS } from '../src/alerts'
import { practiceAlertWindow, practiceSettings } from '../src/practice/config'

const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  PRACTICE_SOURCE_URL: 'https://example.test/repo/tests/fixtures/replay/',
  HORAGON_PUBLIC_URL: 'https://horagon.example/',
  ...extra,
})

describe('practiceSettings', () => {
  it('reads the source folder, the public URL and the SOL floor (default 1.0)', () => {
    expect(practiceSettings(env(), 'devnet')).toEqual({
      sourceBase: 'https://example.test/repo/tests/fixtures/replay',
      publicUrl: 'https://horagon.example',
      solFloorLamports: 1_000_000_000n,
    })
    expect(practiceSettings(env({ PRACTICE_SOL_FLOOR: '0.5' }), 'devnet').solFloorLamports).toBe(
      500_000_000n,
    )
    expect(practiceSettings(env({ PRACTICE_SOL_FLOOR: '' }), 'devnet').solFloorLamports).toBe(
      1_000_000_000n,
    )
  })

  it('refuses to start without PRACTICE_SOURCE_URL or HORAGON_PUBLIC_URL', () => {
    expect(() => practiceSettings(env({ PRACTICE_SOURCE_URL: undefined }), 'devnet')).toThrow(
      /PRACTICE_SOURCE_URL is not set/,
    )
    expect(() => practiceSettings(env({ HORAGON_PUBLIC_URL: undefined }), 'devnet')).toThrow(
      /HORAGON_PUBLIC_URL is not set/,
    )
    expect(() =>
      practiceSettings(env({ HORAGON_PUBLIC_URL: 'http://x.example' }), 'devnet'),
    ).toThrow(/must be https/)
  })

  it('refuses a SOL floor that is not a number of SOL', () => {
    for (const v of ['abc', '-1', 'NaN', '100000']) {
      expect(() => practiceSettings(env({ PRACTICE_SOL_FLOOR: v }), 'devnet'), v).toThrow(
        /PRACTICE_SOL_FLOOR/,
      )
    }
  })
})

describe('practiceAlertWindow', () => {
  it('pages the SOL floor once a day, and a failing or challenged run every 3 h', () => {
    expect(practiceAlertWindow('practice-sol-floor')).toBe(86_400)
    expect(practiceAlertWindow('practice-sol-authority')).toBe(86_400)
    expect(practiceAlertWindow('practice-failing')).toBe(PERSON_ALERT_SECS)
    expect(practiceAlertWindow('practice-challenged:practice-401910007p0')).toBe(PERSON_ALERT_SECS)
    expect(practiceAlertWindow('stuck:practice-401910007p0')).toBe(PERSON_ALERT_SECS)
    expect(practiceAlertWindow('fail:create:practice-401910007p0')).toBeUndefined()
  })
})
