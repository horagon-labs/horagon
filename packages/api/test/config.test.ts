import type { Db } from '@horagon/db'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
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

  it('runs without a sponsor when no key is set', () => {
    const deps = depsFromEnv({ ...base, HORAGON_PUBLIC_URL: 'https://horagon.test/' }, db)
    expect(deps.sponsor).toBeUndefined()
    expect(deps.cluster).toBe('devnet')
    expect(deps.publicUrl).toBe('https://horagon.test')
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
