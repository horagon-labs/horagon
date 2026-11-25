import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db } from '@horagon/db'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { afterAll, describe, expect, it } from 'vitest'
import { assertNotMainnet, depsFromEnv, parseSecretKey } from '../src/config'

describe('parseSecretKey', () => {
  it('reads a JSON byte array or base58, ignoring surrounding whitespace', () => {
    const kp = Keypair.generate()
    expect(parseSecretKey(JSON.stringify([...kp.secretKey])).publicKey).toEqual(kp.publicKey)
    expect(parseSecretKey(` ${bs58.encode(kp.secretKey)}\n`).publicKey).toEqual(kp.publicKey)
  })

  it('never quotes the value it was given when it cannot parse it', () => {
    // A trailing comma: JSON.parse's own message would quote the bytes around it.
    const malformed = `[${[...Keypair.generate().secretKey].join(',')},]`
    let err: unknown
    try {
      parseSecretKey(malformed)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(
      'Not a valid secret key: expected base58 or a JSON array of 64 bytes',
    )
    expect((err as Error).cause).toBeUndefined()
  })
})

describe('assertNotMainnet', () => {
  it('refuses a mainnet RPC URL and lets devnet through', () => {
    expect(() => assertNotMainnet('https://api.mainnet-beta.solana.com')).toThrow(
      expect.objectContaining({ code: 'MAINNET_DISABLED' }),
    )
    expect(() => assertNotMainnet('https://api.devnet.solana.com')).not.toThrow()
  })
})

describe('depsFromEnv', () => {
  // A stand-in db: depsFromEnv only passes it along. Nothing here opens a connection.
  const db = {} as Db
  const base = { HORAGON_RPC_URL: 'http://127.0.0.1:8899', IP_HASH_SALT: 'salt' }
  const thrown = (env: Record<string, string>): Error => {
    try {
      depsFromEnv(env, db)
    } catch (e) {
      return e as Error
    }
    throw new Error('depsFromEnv did not throw')
  }

  it('needs the RPC URL and the IP salt', () => {
    expect(thrown({ IP_HASH_SALT: 'salt' }).message).toBe('HORAGON_RPC_URL is not set')
    expect(thrown({ HORAGON_RPC_URL: base.HORAGON_RPC_URL }).message).toBe(
      'IP_HASH_SALT is not set',
    )
  })

  it('refuses mainnet by URL and any cluster but devnet or localnet', () => {
    expect(thrown({ ...base, HORAGON_RPC_URL: 'https://mainnet.helius-rpc.com' })).toMatchObject({
      code: 'MAINNET_DISABLED',
    })
    expect(thrown({ ...base, HORAGON_CLUSTER: 'testnet' })).toMatchObject({
      code: 'MAINNET_DISABLED',
    })
  })

  describe('SPONSOR_KEYPAIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'horagon-sponsor-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    const file = (name: string, text: string) => {
      const p = join(dir, name)
      writeFileSync(p, text)
      return p
    }

    it('reads the keypair from an absolute path', () => {
      const kp = Keypair.generate()
      const path = file('ok.json', JSON.stringify([...kp.secretKey]))
      const deps = depsFromEnv({ ...base, SPONSOR_KEYPAIR: path }, db)
      expect(deps.sponsor?.keypair.publicKey).toEqual(kp.publicKey)
    })

    it('lets SPONSOR_SECRET_KEY win without reading the file', () => {
      const kp = Keypair.generate()
      const deps = depsFromEnv(
        {
          ...base,
          SPONSOR_SECRET_KEY: bs58.encode(kp.secretKey),
          SPONSOR_KEYPAIR: join(dir, 'does-not-exist.json'),
        },
        db,
      )
      expect(deps.sponsor?.keypair.publicKey).toEqual(kp.publicKey)
    })

    it('names the variable for a missing file', () => {
      const path = join(dir, 'missing.json')
      expect(thrown({ ...base, SPONSOR_KEYPAIR: path }).message).toBe(
        `SPONSOR_KEYPAIR: cannot read the keypair file at ${path}`,
      )
    })

    it('rejects a file of the wrong length or not JSON, without quoting it', () => {
      const short = file('short.json', JSON.stringify([...Keypair.generate().secretKey].slice(1)))
      const notJson = file('bad.json', 'top-secret-looking-text')
      for (const path of [short, notJson]) {
        const err = thrown({ ...base, SPONSOR_KEYPAIR: path })
        expect(err.message).toBe(
          `SPONSOR_KEYPAIR: ${path} is not a Solana keypair file (a JSON array of 64 bytes)`,
        )
        expect(err.message).not.toContain('top-secret')
      }
    })

    it('rejects a relative path', () => {
      expect(thrown({ ...base, SPONSOR_KEYPAIR: '.keys/sponsor.json' }).message).toBe(
        'SPONSOR_KEYPAIR must be an absolute path',
      )
    })
  })

  it('runs without a sponsor when no key is set', () => {
    const deps = depsFromEnv({ ...base, HORAGON_PUBLIC_URL: 'https://horagon.test/' }, db)
    expect(deps.sponsor).toBeUndefined()
    expect(deps.cluster).toBe('devnet')
    expect(deps.publicUrl).toBe('https://horagon.test')
  })

  it('reports the commit SHA, falling back to HORAGON_VERSION when it is empty', () => {
    const version = (env: Record<string, string>) => depsFromEnv({ ...base, ...env }, db).version
    expect(version({ VERCEL_GIT_COMMIT_SHA: '967b2b0aa1b2c3d4', HORAGON_VERSION: 'x' })).toBe(
      '967b2b0',
    )
    // `vercel deploy` from the CLI sets VERCEL_GIT_COMMIT_SHA to an empty string.
    expect(version({ VERCEL_GIT_COMMIT_SHA: '', HORAGON_VERSION: 'abc1234' })).toBe('abc1234')
    expect(version({ VERCEL_GIT_COMMIT_SHA: '', HORAGON_VERSION: '' })).toBe('dev')
    expect(version({})).toBe('dev')
  })

  it('reads the sponsor key with the default limits', () => {
    const kp = Keypair.generate()
    const deps = depsFromEnv({ ...base, SPONSOR_SECRET_KEY: bs58.encode(kp.secretKey) }, db)
    expect(deps.sponsor?.keypair.publicKey).toEqual(kp.publicKey)
    expect(deps.sponsor?.dailyCapLamports).toBe(2_000_000_000n)
    expect(deps.sponsor?.txPerHour).toBe(30)
    expect(deps.sponsor?.atasPerDay).toEqual({ wallet: 26, ip: 78 })
  })

  it('reads the limits, allowing 0 new token accounts', () => {
    const deps = depsFromEnv(
      {
        ...base,
        SPONSOR_SECRET_KEY: bs58.encode(Keypair.generate().secretKey),
        SPONSOR_DAILY_CAP_SOL: '0.5',
        SPONSOR_TX_PER_HOUR: '12',
        SPONSOR_ATAS_PER_WALLET_DAY: '0',
        SPONSOR_ATAS_PER_IP_DAY: '0',
      },
      db,
    )
    expect(deps.sponsor?.dailyCapLamports).toBe(500_000_000n)
    expect(deps.sponsor?.txPerHour).toBe(12)
    expect(deps.sponsor?.atasPerDay).toEqual({ wallet: 0, ip: 0 })
  })

  const perHour = 'SPONSOR_TX_PER_HOUR must be a whole number of 1 or more'
  const sol = 'SPONSOR_DAILY_CAP_SOL must be an amount of SOL above 0'
  it.each([
    ['SPONSOR_TX_PER_HOUR', 'abc', perHour],
    ['SPONSOR_TX_PER_HOUR', '0', perHour],
    ['SPONSOR_TX_PER_HOUR', '1.5', perHour],
    [
      'SPONSOR_ATAS_PER_WALLET_DAY',
      '-1',
      'SPONSOR_ATAS_PER_WALLET_DAY must be a whole number of 0 or more',
    ],
    [
      'SPONSOR_ATAS_PER_IP_DAY',
      'many',
      'SPONSOR_ATAS_PER_IP_DAY must be a whole number of 0 or more',
    ],
    ['SPONSOR_DAILY_CAP_SOL', '-2', sol],
    ['SPONSOR_DAILY_CAP_SOL', 'lots', sol],
  ])('refuses %s=%s with a fixed message that names the variable', (name, value, message) => {
    const key = bs58.encode(Keypair.generate().secretKey)
    const err = thrown({ ...base, SPONSOR_SECRET_KEY: key, [name]: value })
    expect(err.message).toBe(message)
  })

  it('never echoes a sponsor key it cannot read', () => {
    const bad = `${bs58.encode(Keypair.generate().secretKey)}0OIl`
    const err = thrown({ ...base, SPONSOR_SECRET_KEY: bad })
    expect(err.message).not.toContain(bad.slice(0, 20))
  })
})
