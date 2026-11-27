import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEVNET_MUSDC_MINT, HoragonError } from '@horagon/sdk'
import { type Connection, Keypair } from '@solana/web3.js'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertCluster,
  assertNotMainnet,
  ClusterMismatch,
  createLogger,
  DEVNET_GENESIS_HASH,
  indexReadConnection,
  isClusterRefusal,
  loadConfig,
  loadKeypair,
  MAINNET_GENESIS_HASH,
  makeConnection,
  REPO_DIR,
  resolveKeyPath,
  rpcEndpoints,
  rpcHost,
  telegramSettings,
  timeoutFetch,
  verifyCluster,
} from '../src/config'
import { DEFAULT_SEEDS, DEFAULT_TIMINGS } from '../src/planner'

const silent = pino({ level: 'silent' })
let dir: string
let keyFile: string
const attestor = Keypair.generate()

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'horagon-config-'))
  await mkdir(join(dir, 'keys'))
  keyFile = join(dir, 'keys', 'attestor.json')
  await writeFile(keyFile, JSON.stringify(Array.from(attestor.secretKey)))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The smallest valid environment, with the attestor key in the temp dir. */
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  HORAGON_RPC_URL: 'https://api.devnet.solana.com',
  DATABASE_URL: 'postgres://keeper:pw@db.example:5432/horagon',
  ATTESTOR_KEYPAIR: keyFile,
  ...extra,
})

describe('REPO_DIR and key paths', () => {
  it('is the repo root, whatever the working directory', () => {
    expect(REPO_DIR).toBe(resolve(import.meta.dirname, '../../..'))
    expect(existsSync(join(REPO_DIR, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('resolves a relative key path from the repo root, an absolute one as is', () => {
    expect(resolveKeyPath('.keys/attestor.json')).toBe(join(REPO_DIR, '.keys', 'attestor.json'))
    expect(resolveKeyPath(keyFile)).toBe(keyFile)
    expect(resolveKeyPath('keys/attestor.json', dir)).toBe(keyFile)
  })
})

describe('loadKeypair', () => {
  it('reads a Solana CLI keypair file', () => {
    expect(loadKeypair(keyFile).publicKey.toBase58()).toBe(attestor.publicKey.toBase58())
  })

  it('refuses a bad file without quoting what is in it', async () => {
    const secret = JSON.stringify(Array.from(Keypair.generate().secretKey))
    const cases: Record<string, string> = {
      'truncated.json': secret.slice(0, 40),
      'short.json': JSON.stringify(Array.from(attestor.secretKey.slice(0, 32))),
      'mismatch.json': JSON.stringify([...attestor.secretKey.slice(0, 32), ...new Uint8Array(32)]),
      'bytes.json': JSON.stringify([...Array(63).fill(1), 256]),
    }
    for (const [name, body] of Object.entries(cases)) {
      const path = join(dir, name)
      await writeFile(path, body)
      let message = ''
      try {
        loadKeypair(path)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message, name).toContain(path)
      expect(message, name).toContain('not a Solana keypair file')
      expect(message, name).not.toMatch(/\d{2,3},\d{1,3}/)
    }
    expect(() => loadKeypair(join(dir, 'missing.json'))).toThrow('cannot read')
  })
})

describe('assertNotMainnet', () => {
  it('refuses mainnet in the host or the path, without echoing the URL', () => {
    for (const url of [
      'https://api.mainnet-beta.solana.com',
      'https://mainnet.helius-rpc.com/?api-key=SECRET',
      'https://rpc.example.com/solana_MAINNET/SECRET',
      'wss://mainnet.example.com/ws',
    ]) {
      let message = ''
      try {
        assertNotMainnet(url)
      } catch (err) {
        expect(err).toBeInstanceOf(HoragonError)
        message = (err as Error).message
      }
      expect(message, url).toContain('devnet only')
      expect(message, url).not.toContain('SECRET')
    }
    expect(() => assertNotMainnet('https://api.devnet.solana.com')).not.toThrow()
    expect(() => assertNotMainnet('https://devnet.helius-rpc.com/?api-key=mainnet')).not.toThrow()
    expect(() => assertNotMainnet('not a url ?api-key=SECRET')).toThrow(/^not a valid RPC URL$/)
  })
})

describe('assertCluster', () => {
  const rpc = (genesis: string | Error) => {
    const calls = { n: 0 }
    return {
      calls,
      conn: {
        async getGenesisHash() {
          calls.n++
          if (genesis instanceof Error) throw genesis
          return genesis
        },
      },
    }
  }

  it('accepts devnet by its genesis hash, with one RPC call', async () => {
    const { conn, calls } = rpc(DEVNET_GENESIS_HASH)
    await expect(assertCluster(conn, 'devnet')).resolves.toBeUndefined()
    expect(calls.n).toBe(1)
  })

  it('refuses mainnet on every cluster, with the SDK error', async () => {
    expect(MAINNET_GENESIS_HASH).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
    for (const cluster of ['devnet', 'localnet'] as const) {
      const err = await assertCluster(rpc(MAINNET_GENESIS_HASH).conn, cluster).catch((e) => e)
      expect(err).toBeInstanceOf(HoragonError)
      expect((err as HoragonError).code).toBe('MAINNET_DISABLED')
      expect(isClusterRefusal(err)).toBe(true)
    }
  })

  it('refuses another genesis on devnet, accepts it on localnet', async () => {
    const local = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'
    const err = await assertCluster(rpc(local).conn, 'devnet').catch((e) => e)
    expect(err).toBeInstanceOf(ClusterMismatch)
    expect(isClusterRefusal(err)).toBe(true)
    await expect(assertCluster(rpc(local).conn, 'localnet')).resolves.toBeUndefined()
  })

  it('rethrows an RPC failure as it is: unknown, not a refusal', async () => {
    const err = await assertCluster(rpc(new Error('fetch failed')).conn, 'devnet').catch((e) => e)
    expect((err as Error).message).toBe('fetch failed')
    expect(isClusterRefusal(err)).toBe(false)
  })

  it('verifyCluster waits out a primary that does not answer, but never a refusal', async () => {
    const sleeps: number[] = []
    const sleep = async (ms: number) => void sleeps.push(ms)
    let n = 0
    const flaky = {
      async getGenesisHash() {
        n++
        if (n <= 5) throw new Error('fetch failed')
        return DEVNET_GENESIS_HASH
      },
    }
    const ok = rpc(DEVNET_GENESIS_HASH)
    const verified = await verifyCluster([flaky, ok.conn], 'devnet', {
      log: silent,
      sleep,
      maxDelayMs: 30_000,
    })
    expect(verified).toEqual([flaky, ok.conn])
    expect(ok.calls.n).toBe(1)
    expect(sleeps).toEqual([5_000, 10_000, 20_000, 30_000, 30_000])

    sleeps.length = 0
    const refused = verifyCluster([ok.conn, rpc(MAINNET_GENESIS_HASH).conn], 'devnet', {
      log: silent,
      sleep,
    })
    await expect(refused).rejects.toThrow(HoragonError)
    expect(sleeps).toEqual([])
  })

  it('verifyCluster starts without a backup that fails 3 tries, and says so', async () => {
    const sleeps: number[] = []
    const sleep = async (ms: number) => void sleeps.push(ms)
    const lines: Array<Record<string, unknown>> = []
    const log = pino({ level: 'warn' }, { write: (l: string) => void lines.push(JSON.parse(l)) })
    const down: Array<[number, string]> = []
    const dead = rpc(new Error('connect ECONNREFUSED https://backup.example/?api-key=SECRET'))
    const ok = rpc(DEVNET_GENESIS_HASH)
    const verified = await verifyCluster([ok.conn, dead.conn], 'devnet', {
      log,
      sleep,
      onBackupDown: async (i, error) => void down.push([i, error]),
    })
    // Never used unverified: only the primary comes back.
    expect(verified).toEqual([ok.conn])
    expect(dead.calls.n).toBe(3)
    expect(sleeps).toEqual([5_000, 10_000])
    expect(down).toHaveLength(1)
    expect(down[0]?.[0]).toBe(1)
    expect(down[0]?.[1]).toContain('ECONNREFUSED')
    expect(lines.at(-1)).toMatchObject({ level: 40, rpc: 1, tries: 3 })
    expect(JSON.stringify([lines, down])).not.toContain('SECRET')

    // A backup that answers within its tries is kept; one that is refused still throws.
    let m = 0
    const slow = {
      async getGenesisHash() {
        m++
        if (m <= 2) throw new Error('fetch failed')
        return DEVNET_GENESIS_HASH
      },
    }
    expect(await verifyCluster([ok.conn, slow], 'devnet', { log: silent, sleep })).toEqual([
      ok.conn,
      slow,
    ])
    const wrong = rpc('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY')
    await expect(
      verifyCluster([ok.conn, wrong.conn], 'devnet', {
        log: silent,
        sleep,
        onBackupDown: async () => {},
      }),
    ).rejects.toThrow(ClusterMismatch)
  })
})

describe('rpcEndpoints', () => {
  const urls = ['https://a.devnet.example', 'https://b.devnet.example']

  it('matches RPC_WS_URLS to the RPC URLs by position; an empty entry is derived', () => {
    expect(rpcEndpoints(urls)).toEqual([{ url: urls[0] }, { url: urls[1] }])
    expect(rpcEndpoints(urls, '')).toEqual([{ url: urls[0] }, { url: urls[1] }])
    expect(rpcEndpoints(urls, 'wss://a.devnet.example/ws')).toEqual([
      { url: urls[0], wsUrl: 'wss://a.devnet.example/ws' },
      { url: urls[1] },
    ])
    expect(rpcEndpoints(urls, ' , wss://b.devnet.example/ws ')).toEqual([
      { url: urls[0] },
      { url: urls[1], wsUrl: 'wss://b.devnet.example/ws' },
    ])
  })

  it('refuses mainnet, a non-wss entry, and more entries than RPC URLs', () => {
    expect(() => rpcEndpoints(['https://api.mainnet-beta.solana.com'])).toThrow('devnet only')
    expect(() => rpcEndpoints(urls, ',wss://mainnet.example/ws')).toThrow('devnet only')
    expect(() => rpcEndpoints(urls, 'ws://a.devnet.example')).toThrow('wss://')
    expect(() => rpcEndpoints(urls, 'https://a.devnet.example')).toThrow('wss://')
    expect(() => rpcEndpoints(urls, 'not a url')).toThrow('wss://')
    expect(() => rpcEndpoints(urls, 'wss://a.x,wss://b.x,wss://c.x')).toThrow('3 entries')
  })
})

describe('makeConnection', () => {
  it('is confirmed, keeps an explicit wsEndpoint, and fails fast on a 429', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response('slow down', { status: 429, statusText: 'Too Many Requests' })
    }) as unknown as typeof fetch
    const conn = makeConnection('https://rpc.devnet.example', 'wss://ws.devnet.example', {
      fetchImpl,
    })
    expect(conn.commitment).toBe('confirmed')
    expect(conn.rpcEndpoint).toBe('https://rpc.devnet.example')
    expect((conn as unknown as { _rpcWsEndpoint: string })._rpcWsEndpoint).toBe(
      'wss://ws.devnet.example',
    )
    // Without disableRetryOnRateLimit web3.js would retry for about 7.5 s on its own.
    const started = Date.now()
    await expect(conn.getGenesisHash()).rejects.toThrow('429')
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('derives the websocket from the RPC URL when none is given', () => {
    const conn = makeConnection('https://rpc.devnet.example') as unknown as {
      _rpcWsEndpoint: string
    }
    expect(conn._rpcWsEndpoint).toBe('wss://rpc.devnet.example')
  })

  it('gives every RPC call a timeout', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof fetch
    const conn: Connection = makeConnection('https://rpc.devnet.example', undefined, {
      fetchImpl: hang,
      timeoutMs: 50,
    })
    await expect(conn.getGenesisHash()).rejects.toThrow(/timeout|aborted/i)
  })
})

describe('timeoutFetch', () => {
  it("combines its timeout with the caller's signal", async () => {
    const seen: AbortSignal[] = []
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init?.signal) seen.push(init.signal)
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof fetch
    const caller = new AbortController()
    const pending = timeoutFetch(60_000, hang)('https://x.example', { signal: caller.signal })
    caller.abort(new Error('caller gave up'))
    await expect(pending).rejects.toThrow('caller gave up')

    await expect(timeoutFetch(20, hang)('https://x.example')).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(seen).toHaveLength(2)
  })
})

describe('loadConfig', () => {
  it('fills the defaults', () => {
    const c = loadConfig(env())
    expect(c.rpcs).toEqual([{ url: 'https://api.devnet.solana.com' }])
    expect(c.cluster).toBe('devnet')
    expect(c.attestor.publicKey.toBase58()).toBe(attestor.publicKey.toBase58())
    expect(c.collateralMint.equals(DEVNET_MUSDC_MINT)).toBe(true)
    expect(c.telegram).toBeNull()
    expect(c.sponsor).toBeNull()
    expect(c.feed).toEqual({ kind: 'espn', archiveDir: join(REPO_DIR, 'apps/keeper/data/archive') })
    expect(c.eloFile).toBe(join(REPO_DIR, 'apps/keeper/data/elo.json'))
    expect(c.timings).toEqual(DEFAULT_TIMINGS)
    expect(c.seeds).toEqual(DEFAULT_SEEDS)
    expect(c.priority).toEqual({ normal: 10_000, halt: 200_000 })
    expect(c.faucetUrl).toBe('https://pm-amm-devnet.vercel.app/api/faucet')
    expect(c.logLevel).toBe('info')
    expect(c.stallSecs).toBe(120)
  })

  it('reads KEEPER_STALL_SECS and refuses less than 30', () => {
    expect(loadConfig(env({ KEEPER_STALL_SECS: '45' })).stallSecs).toBe(45)
    expect(loadConfig(env({ KEEPER_STALL_SECS: '30' })).stallSecs).toBe(30)
    expect(() => loadConfig(env({ KEEPER_STALL_SECS: '29' }))).toThrow(/KEEPER_STALL_SECS/)
  })

  it('resolves a relative key path from the repo root, not the working directory', () => {
    const c = loadConfig(env({ ATTESTOR_KEYPAIR: 'keys/attestor.json' }), { repoDir: dir })
    expect(c.attestor.publicKey.toBase58()).toBe(attestor.publicKey.toBase58())
    expect(() => loadConfig(env({ ATTESTOR_KEYPAIR: 'keys/attestor.json' }))).toThrow(
      join(REPO_DIR, 'keys', 'attestor.json'),
    )
  })

  it('refuses a mainnet RPC, primary, backup or websocket, and a non-http RPC', () => {
    const main = 'https://api.mainnet-beta.solana.com'
    expect(() => loadConfig(env({ HORAGON_RPC_URL: main }))).toThrow('devnet only')
    expect(() => loadConfig(env({ HORAGON_RPC_BACKUP_URL: main }))).toThrow('devnet only')
    expect(() => loadConfig(env({ RPC_WS_URLS: 'wss://mainnet.example' }))).toThrow('devnet only')
    expect(() => loadConfig(env({ HORAGON_RPC_URL: 'ftp://devnet.example' }))).toThrow(
      'HORAGON_RPC_URL',
    )
    expect(() => loadConfig(env({ HORAGON_CLUSTER: 'mainnet-beta' }))).toThrow('HORAGON_CLUSTER')
  })

  it('takes a backup RPC and the websocket URLs by position', () => {
    const c = loadConfig(
      env({
        HORAGON_RPC_BACKUP_URL: 'https://backup.devnet.example',
        RPC_WS_URLS: ',wss://backup.devnet.example/ws',
      }),
    )
    expect(c.rpcs).toEqual([
      { url: 'https://api.devnet.solana.com' },
      { url: 'https://backup.devnet.example', wsUrl: 'wss://backup.devnet.example/ws' },
    ])
  })

  it('never echoes a value in its validation error', () => {
    let message = ''
    try {
      loadConfig({ HORAGON_RPC_URL: 'nope', DATABASE_URL: '', LOG_LEVEL: 'SECRETLEVEL' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('HORAGON_RPC_URL')
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('LOG_LEVEL')
    expect(message).not.toContain('SECRETLEVEL')
    expect(message).not.toContain('nope')
  })

  it('reads a replay feed, which needs a tag starting with a letter and a tip-off', () => {
    const replay = {
      KEEPER_FEED: 'replay',
      REPLAY_TAG: 'r1',
      REPLAY_TIPOFF: '2026-11-24T00:30:00Z',
      REPLAY_SPEED: '10',
    }
    expect(loadConfig(env(replay)).feed).toEqual({
      kind: 'replay',
      dir: join(REPO_DIR, 'tests/fixtures/replay'),
      tag: 'r1',
      tipoff: new Date('2026-11-24T00:30:00Z'),
      speed: 10,
    })
    expect(() => loadConfig(env({ KEEPER_FEED: 'replay', REPLAY_TAG: 'r1' }))).toThrow(
      'REPLAY_TIPOFF',
    )
    expect(() => loadConfig(env({ ...replay, REPLAY_TAG: '1r' }))).toThrow('REPLAY_TAG')
    expect(() => loadConfig(env({ ...replay, REPLAY_SPEED: '61' }))).toThrow('REPLAY_SPEED')
  })

  it('overrides some timings and seeds; refuses an unknown or bad timing', () => {
    const c = loadConfig(
      env({
        KEEPER_TIMINGS: '{"createLeadSecs":120,"endOffsetSecs":600}',
        SEED_FEATURED_USDC: '500',
        SEED_REGULAR_USDC: '100',
      }),
    )
    expect(c.timings).toEqual({ ...DEFAULT_TIMINGS, createLeadSecs: 120, endOffsetSecs: 600 })
    expect(c.seeds).toEqual({ featured: 500_000_000n, regular: 100_000_000n })
    expect(() => loadConfig(env({ KEEPER_TIMINGS: '{"createLead":120}' }))).toThrow(
      'KEEPER_TIMINGS',
    )
    expect(() => loadConfig(env({ KEEPER_TIMINGS: '{"endOffsetSecs":299}' }))).toThrow(
      'KEEPER_TIMINGS',
    )
    expect(() => loadConfig(env({ KEEPER_TIMINGS: 'not json' }))).toThrow('KEEPER_TIMINGS')
  })

  it('turns auto-propose on with a usable HORAGON_PUBLIC_URL, and off with the reason without', () => {
    expect(loadConfig(env()).autoPropose).toEqual({
      mode: 'off',
      publicUrl: null,
      off: 'HORAGON_PUBLIC_URL is not set',
    })
    const url = { HORAGON_PUBLIC_URL: 'https://www.horagon.xyz/' }
    expect(loadConfig(env(url)).autoPropose).toEqual({
      mode: 'on',
      publicUrl: 'https://www.horagon.xyz',
      off: null,
    })
    // A blank line keeps the default.
    expect(loadConfig(env({ ...url, KEEPER_AUTO_PROPOSE: '' })).autoPropose.mode).toBe('on')
    expect(loadConfig(env({ ...url, KEEPER_AUTO_PROPOSE: 'dry' })).autoPropose.mode).toBe('dry')
    expect(loadConfig(env({ ...url, KEEPER_AUTO_PROPOSE: 'off' })).autoPropose).toEqual({
      mode: 'off',
      publicUrl: null,
      off: 'KEEPER_AUTO_PROPOSE=off',
    })
    expect(() => loadConfig(env({ ...url, KEEPER_AUTO_PROPOSE: 'yes' }))).toThrow(
      'KEEPER_AUTO_PROPOSE',
    )
    // A URL the evidence link cannot use turns it off; the keeper still starts.
    expect(
      loadConfig(env({ HORAGON_PUBLIC_URL: 'http://www.horagon.xyz' })).autoPropose,
    ).toMatchObject({ mode: 'off', off: 'HORAGON_PUBLIC_URL must be https' })
    expect(loadConfig(env({ HORAGON_PUBLIC_URL: 'not a url' })).autoPropose.off).toBe(
      'HORAGON_PUBLIC_URL is not a URL',
    )
    const long = `https://www.horagon.xyz/${'a'.repeat(60)}`
    expect(loadConfig(env({ HORAGON_PUBLIC_URL: long })).autoPropose.off).toMatch(
      /^the evidence URI is longer than 128 characters/,
    )
  })

  it('reads BALLDONTLIE_API_KEY, a blank one as unset, and never prints a bad one', () => {
    expect(loadConfig(env()).balldontlieKey).toBeNull()
    expect(loadConfig(env({ BALLDONTLIE_API_KEY: '' })).balldontlieKey).toBeNull()
    const key = 'x'.repeat(16)
    expect(loadConfig(env({ BALLDONTLIE_API_KEY: key })).balldontlieKey).toBe(key)
    const short = 'y'.repeat(7)
    let message = ''
    try {
      loadConfig(env({ BALLDONTLIE_API_KEY: short }))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('BALLDONTLIE_API_KEY')
    expect(message).not.toContain(short)
  })

  it('reads the second-source wait of auto-propose from KEEPER_TIMINGS', () => {
    expect(DEFAULT_TIMINGS.secondSourceWaitSecs).toBe(600)
    const c = loadConfig(env({ KEEPER_TIMINGS: '{"secondSourceWaitSecs":300}' }))
    expect(c.timings.secondSourceWaitSecs).toBe(300)
    expect(() => loadConfig(env({ KEEPER_TIMINGS: '{"secondSourceWaitSecs":-1}' }))).toThrow(
      'KEEPER_TIMINGS',
    )
  })

  it('needs both Telegram values or neither, and reads the sponsor public key', () => {
    const sponsor = Keypair.generate().publicKey.toBase58()
    const c = loadConfig(
      env({ TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', SPONSOR_PUBKEY: sponsor }),
    )
    expect(c.telegram).toEqual({ token: 'T', chatId: '42' })
    expect(c.sponsor?.toBase58()).toBe(sponsor)
    expect(() => loadConfig(env({ TELEGRAM_BOT_TOKEN: 'T' }))).toThrow('TELEGRAM_CHAT_ID')
    expect(() => loadConfig(env({ SPONSOR_PUBKEY: 'not-a-key' }))).toThrow('SPONSOR_PUBKEY')
  })

  it('telegramSettings takes both or neither, never echoing a value', () => {
    expect(telegramSettings({})).toBeNull()
    expect(telegramSettings({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' })).toBeNull()
    expect(telegramSettings({ TELEGRAM_BOT_TOKEN: 'T0K', TELEGRAM_CHAT_ID: '42' })).toEqual({
      token: 'T0K',
      chatId: '42',
    })
    for (const half of [
      { TELEGRAM_BOT_TOKEN: 'T0K' },
      { TELEGRAM_CHAT_ID: '4242' },
      { TELEGRAM_BOT_TOKEN: 'T0K', TELEGRAM_CHAT_ID: '' },
    ]) {
      const err = (() => {
        try {
          telegramSettings(half)
        } catch (e) {
          return e as Error
        }
        return null
      })()
      expect(err?.message).toBe('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together')
      expect(err?.message).not.toMatch(/T0K|4242/)
    }
  })
})

describe('HORAGON_INDEX_RPC_URL', () => {
  const KEYED = 'https://index.devnet.example/rpc/v1?api-key=SECRET'

  it('is optional: unset or blank uses the main RPC', () => {
    expect(loadConfig(env()).indexRpcUrl).toBeNull()
    expect(loadConfig(env({ HORAGON_INDEX_RPC_URL: '' })).indexRpcUrl).toBeNull()
    expect(loadConfig(env({ HORAGON_INDEX_RPC_URL: KEYED })).indexRpcUrl).toBe(KEYED)
  })

  it('takes https only and never mainnet, without quoting the URL', () => {
    const http = () =>
      loadConfig(env({ HORAGON_INDEX_RPC_URL: 'http://index.devnet.example?k=SECRET' }))
    expect(http).toThrow('HORAGON_INDEX_RPC_URL')
    try {
      http()
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET')
    }
    expect(() =>
      loadConfig(env({ HORAGON_INDEX_RPC_URL: 'https://api.mainnet-beta.solana.com' })),
    ).toThrow('devnet only')
  })

  it('names the host only', () => {
    expect(rpcHost(KEYED)).toBe('index.devnet.example')
    expect(rpcHost('https://user:pw@rpc.example:8899/x?y=z')).toBe('rpc.example')
    expect(rpcHost('not a url')).toBe('(invalid URL)')
  })

  const fakeConn = (genesis: string | Error) =>
    ({
      async getGenesisHash() {
        if (genesis instanceof Error) throw genesis
        return genesis
      },
    }) as unknown as Connection
  const capture = () => {
    const lines: Array<Record<string, unknown>> = []
    const log = pino({ level: 'info' }, { write: (l: string) => void lines.push(JSON.parse(l)) })
    return { lines, log }
  }

  it('unset: index reads follow the main connection, whichever is active', async () => {
    let active = fakeConn(DEVNET_GENESIS_HASH)
    const made: string[] = []
    const get = await indexReadConnection({
      url: null,
      fallback: () => active,
      cluster: 'devnet',
      log: silent,
      make: (u) => {
        made.push(u)
        return fakeConn(DEVNET_GENESIS_HASH)
      },
    })
    expect(get()).toBe(active)
    active = fakeConn(DEVNET_GENESIS_HASH)
    expect(get()).toBe(active)
    expect(made).toEqual([])
  })

  it('set: a separate, verified Connection on that URL, logged by host only', async () => {
    const main = fakeConn(DEVNET_GENESIS_HASH)
    const own = fakeConn(DEVNET_GENESIS_HASH)
    const made: string[] = []
    const { lines, log } = capture()
    const get = await indexReadConnection({
      url: KEYED,
      fallback: () => main,
      cluster: 'devnet',
      log,
      make: (u) => {
        made.push(u)
        return own
      },
    })
    expect(made).toEqual([KEYED])
    expect(get()).toBe(own)
    expect(get()).not.toBe(main)
    expect(lines.at(-1)).toMatchObject({ indexRpcHost: 'index.devnet.example' })
    expect(JSON.stringify(lines)).not.toContain('SECRET')
    expect(JSON.stringify(lines)).not.toContain('/rpc/v1')
  })

  it('refuses a mainnet or wrong-cluster index RPC, and falls back from one that does not answer', async () => {
    const main = fakeConn(DEVNET_GENESIS_HASH)
    const sleep = async () => {}
    await expect(
      indexReadConnection({
        url: KEYED,
        fallback: () => main,
        cluster: 'devnet',
        log: silent,
        sleep,
        make: () => fakeConn(MAINNET_GENESIS_HASH),
      }),
    ).rejects.toThrow(HoragonError)
    await expect(
      indexReadConnection({
        url: KEYED,
        fallback: () => main,
        cluster: 'devnet',
        log: silent,
        sleep,
        make: () => fakeConn('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'),
      }),
    ).rejects.toThrow(ClusterMismatch)

    const { lines, log } = capture()
    const down: string[] = []
    const get = await indexReadConnection({
      url: KEYED,
      fallback: () => main,
      cluster: 'devnet',
      log,
      sleep,
      make: () => fakeConn(new Error(`connect ECONNREFUSED ${KEYED}`)),
      onDown: async (error) => void down.push(error),
    })
    expect(get()).toBe(main)
    expect(down).toHaveLength(1)
    expect(lines.at(-1)).toMatchObject({ level: 40, indexRpcHost: 'index.devnet.example' })
    expect(JSON.stringify([lines, down])).not.toContain('SECRET')
  })
})

describe('createLogger', () => {
  it('writes JSON with the service name and redacts tokens and secret keys', () => {
    const lines: string[] = []
    const log = createLogger('info', 'ops', { write: (l: string) => void lines.push(l) })
    log.info({ token: 'BOTSECRET', nested: { secretKey: 'KEYSECRET' } }, 'hello')
    log.debug('hidden')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ service: 'ops', msg: 'hello' })
    expect(lines[0]).not.toContain('BOTSECRET')
    expect(lines[0]).not.toContain('KEYSECRET')
  })
})
