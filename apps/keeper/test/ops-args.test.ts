import { HoragonError } from '@horagon/sdk'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { ProgramFailure, UnresolvedAttempt } from '../src/executor'
import {
  boxScoreUrl,
  disputeWindowArg,
  flagArgs,
  gameDateArg,
  noticeUrl,
  opsArgv,
  opsErrorReport,
  publicKeyArg,
  signatureIn,
  stripArgSeparator,
} from '../src/ops/args'

const SIG = '5'.repeat(44) + 'A'.repeat(44)

describe('stripArgSeparator', () => {
  it('drops the leading -- that pnpm 10.10 passes through, and only that one', () => {
    expect(stripArgSeparator(['--', 'status', '--date', '2026-11-24'])).toEqual([
      'status',
      '--date',
      '2026-11-24',
    ])
    expect(stripArgSeparator(['status', '--date', '2026-11-24'])).toEqual([
      'status',
      '--date',
      '2026-11-24',
    ])
    expect(stripArgSeparator(['propose', 'nba-1', '--', 'x'])).toEqual([
      'propose',
      'nba-1',
      '--',
      'x',
    ])
    expect(stripArgSeparator(['--', '--'])).toEqual(['--'])
    expect(stripArgSeparator([])).toEqual([])
  })
})

describe('opsArgv', () => {
  it('reads --help and -h as the help command, before any -- terminator', () => {
    expect(opsArgv(['--help'])).toEqual(['help'])
    expect(opsArgv(['-h'])).toEqual(['help'])
    expect(opsArgv(['--', '--help'])).toEqual(['help'])
    expect(opsArgv(['propose', 'nba-1', '-h'])).toEqual(['help'])
    expect(opsArgv(['help'])).toEqual(['help'])
    expect(opsArgv(['--', 'status', '--date', '2026-11-24'])).toEqual([
      'status',
      '--date',
      '2026-11-24',
    ])
    expect(opsArgv(['propose', 'nba-1', '--', '-h'])).toEqual(['propose', 'nba-1', '--', '-h'])
    expect(opsArgv([])).toEqual([])
  })
})

describe('noticeUrl', () => {
  it('stores the normalised href of an https notice', () => {
    expect(noticeUrl('  HTTPS://WWW.NBA.COM/news/postponed  ')).toBe(
      'https://www.nba.com/news/postponed',
    )
    // The default port is not a port.
    expect(noticeUrl('https://nba.com:443/x')).toBe('https://nba.com/x')
    expect(noticeUrl('https://example.org/a?b=c#d')).toBe('https://example.org/a?b=c#d')
  })

  it('refuses anything but a plain https URL of at most 256 characters', () => {
    expect(() => noticeUrl(undefined)).toThrow('--notice')
    expect(() => noticeUrl('')).toThrow('--notice')
    expect(() => noticeUrl('not a url')).toThrow('--notice')
    expect(() => noticeUrl('http://nba.com/x')).toThrow('https')
    expect(() => noticeUrl('https://user:pw@nba.com/x')).toThrow('credentials')
    expect(() => noticeUrl('https://user@nba.com/x')).toThrow('credentials')
    expect(() => noticeUrl('https://nba.com:8443/x')).toThrow('port')
    const long = `https://nba.com/${'a'.repeat(240)}`
    expect(long.length).toBe(256)
    expect(noticeUrl(long)).toBe(long)
    expect(() => noticeUrl(`${long}b`)).toThrow('256')
  })
})

describe('boxScoreUrl', () => {
  it("stores checkBoxScoreUrl's normalised href and its source", () => {
    expect(boxScoreUrl('  HTTPS://WWW.NBA.COM/game/x  ')).toEqual({
      url: 'https://www.nba.com/game/x',
      source: 'nba',
    })
    expect(boxScoreUrl('https://www.espn.com/nba/boxscore/_/gameId/1')).toMatchObject({
      url: 'https://www.espn.com/nba/boxscore/_/gameId/1',
      source: 'espn-box-score',
      warning: expect.stringContaining('ESPN'),
    })
  })

  it('names the flag in every refusal', () => {
    expect(() => boxScoreUrl(undefined)).toThrow('--box-score: not a URL')
    expect(() => boxScoreUrl('https://example.org/x')).toThrow('--box-score: example.org')
    expect(() => boxScoreUrl('https://nba.com:8443/x')).toThrow('--box-score: must not set a port')
  })
})

describe('gameDateArg', () => {
  it('accepts a real YYYY-MM-DD date only', () => {
    expect(gameDateArg('2026-11-24', '--date')).toBe('2026-11-24')
    expect(() => gameDateArg('2026-02-30', '--date')).toThrow('--date')
    expect(() => gameDateArg('20261124', 'gameDate')).toThrow('gameDate')
    expect(() => gameDateArg(undefined, 'gameDate')).toThrow('gameDate')
  })
})

describe('disputeWindowArg and publicKeyArg', () => {
  it('takes the program bounds for the dispute window, 900 s by default', () => {
    expect(disputeWindowArg(undefined)).toBe(900)
    expect(disputeWindowArg('60')).toBe(60)
    expect(disputeWindowArg('604800')).toBe(604_800)
    for (const bad of ['59', '604801', '9.5', '15m', '', '-900']) {
      expect(() => disputeWindowArg(bad), bad).toThrow('--window')
    }
  })

  it('names the argument when a public key does not parse', () => {
    const key = Keypair.generate().publicKey
    expect(publicKeyArg('--guardian', key.toBase58()).equals(key)).toBe(true)
    expect(() => publicKeyArg('--guardian', 'nope')).toThrow('--guardian is not a public key')
    expect(() => publicKeyArg('--guardian', undefined)).toThrow('--guardian is not a public key')
  })
})

describe('signatureIn', () => {
  it('finds the signature in an unresolved message, or nothing', () => {
    expect(signatureIn(`propose nba-1: unresolved after 90 s, ${SIG} may still land`)).toBe(SIG)
    expect(signatureIn('propose nba-1: gave up after 5 attempts: fetch failed')).toBeUndefined()
  })
})

describe('opsErrorReport', () => {
  it('reports an unresolved attempt as unknown, with its signature and no retry', () => {
    const err = new UnresolvedAttempt(`propose nba-1: unresolved after 90 s, ${SIG} may still land`)
    const r = opsErrorReport(err)
    expect(r.exitCode).toBe(3)
    expect(r.lines[0]).toBe(`unknown: propose nba-1: unresolved after 90 s, ${SIG} may still land`)
    expect(r.lines).toContain(`signature: ${SIG}`)
    expect(r.lines.join('\n')).toContain('horagon-ops status')
    expect(r.lines.join('\n')).toMatch(/not retried/)
  })

  it('reports a program failure as an error, never as done', () => {
    const r = opsErrorReport(new ProgramFailure('halt nba-1', 'horagon', 6003, 'BadStatus', []))
    expect(r.exitCode).toBe(1)
    expect(r.lines[0]).toBe('error: halt nba-1: horagon error BadStatus')
    expect(r.lines.join('\n')).not.toMatch(/already|done/i)
  })

  it('redacts URLs and shows errorSignature when there is one', () => {
    const plain = opsErrorReport(new Error('fetch https://rpc.example/?api-key=SECRET failed'))
    expect(plain).toEqual({ exitCode: 1, lines: ['error: fetch https://rpc.example/… failed'] })
    const withSig = new HoragonError('NETWORK', 'sent, answer lost')
    Object.defineProperty(withSig, 'signature', { value: SIG })
    expect(opsErrorReport(withSig).lines).toEqual(['error: sent, answer lost', `signature: ${SIG}`])
    expect(opsErrorReport('a string').lines).toEqual(['error: a string'])
  })
})

describe('flagArgs', () => {
  it('reads on or off, then a flag name', () => {
    expect(flagArgs(['on', 'FLAG_ME'])).toEqual({ name: 'FLAG_ME', on: true })
    expect(flagArgs(['off', 'FLAG_VERIFY'])).toEqual({ name: 'FLAG_VERIFY', on: false })
  })

  it.each<[string[]]>([
    [[]],
    [['on']],
    [['FLAG_ME', 'on']],
    [['enable', 'FLAG_ME']],
    [['on', 'FLAG_ME', 'FLAG_SHARE']],
  ])('refuses %j with the usage', (args) => {
    expect(() => flagArgs(args)).toThrow('usage: flag on|off <FLAG_NAME>')
  })

  it('lists the flags when the name is not one', () => {
    expect(() => flagArgs(['on', 'flag_me'])).toThrow(
      'unknown flag "flag_me"; flags: FLAG_ME, FLAG_METRICS, FLAG_METRICS_COHORT, FLAG_SHARE, FLAG_RANK, FLAG_CREWS, FLAG_TELEGRAM, FLAG_CLUTCH, FLAG_PRACTICE, FLAG_VERIFY',
    )
  })
})
