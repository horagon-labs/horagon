import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { type DbHandle, getHeartbeat, heartbeat } from '@horagon/db'
import {
  DEVNET_MUSDC_MINT,
  deriveMarketPda,
  HoragonProgram,
  SWAP_COMPUTE_UNITS,
} from '@horagon/sdk'
import {
  type Connection,
  Keypair,
  type PublicKey,
  type VersionedTransaction,
  VersionedTransaction as VTx,
} from '@solana/web3.js'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AgentConfig, loadAgentConfig } from '../src/agent/config'
import { AGENT_DOWN_REPAGE_SECS } from '../src/agent/down'
import { agentMain, type Connected, connectAgent, runAgent, UNLISTED_MSG } from '../src/agent/run'
import { agentSwapInstructions } from '../src/agent/tx'
import { DEVNET_GENESIS_HASH } from '../src/config'
import { StallGuard } from '../src/stall'
import { FakeChain, FakeSender, recordingConnection, seedLiveMarket } from './agent-fixtures'

let dir: string
let keyFile: string
/** Repo roots whose docs/metrics-wallets.json lists the agent, lists it otherwise, or is absent. */
let listedRepo: string
let otherRoleRepo: string
let unlistedRepo: string
let brokenRepo: string
let emptyRepo: string
const agent = Keypair.generate()
const sponsor = Keypair.generate()
const DB_URL = 'postgres://agent:SECRETPW@db.example:5432/horagon'
/** Solana testnet's genesis hash: neither devnet nor mainnet. */
const TESTNET_GENESIS_HASH = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'

async function repoWith(name: string, wallets: string | null): Promise<string> {
  const root = join(dir, name)
  await mkdir(join(root, 'docs'), { recursive: true })
  if (wallets !== null) await writeFile(join(root, 'docs', 'metrics-wallets.json'), wallets)
  return root
}

const walletsFile = (teamWallets: Array<{ pubkey: string; role: string }>) =>
  JSON.stringify({
    version: 1,
    teamWallets: teamWallets.map((w) => ({ ...w, addedAt: '2026-11-26' })),
    excludedMarkets: [],
  })

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'horagon-agent-run-'))
  keyFile = join(dir, 'agent.json')
  await writeFile(keyFile, JSON.stringify(Array.from(agent.secretKey)))
  const me = agent.publicKey.toBase58()
  const them = Keypair.generate().publicKey.toBase58()
  listedRepo = await repoWith(
    'listed',
    walletsFile([
      { pubkey: them, role: 'attestor' },
      { pubkey: me, role: 'team-burner' },
    ]),
  )
  otherRoleRepo = await repoWith('other-role', walletsFile([{ pubkey: me, role: 'sponsor' }]))
  unlistedRepo = await repoWith('unlisted', walletsFile([{ pubkey: them, role: 'team-burner' }]))
  brokenRepo = await repoWith('broken', '{"version": 1, "teamWallets": [')
  emptyRepo = await repoWith('empty', null)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function capture() {
  const lines: string[] = []
  const log = pino(
    { level: 'debug' },
    new Writable({
      write(chunk, _enc, cb) {
        lines.push(...String(chunk).split('\n').filter(Boolean))
        cb()
      },
    }),
  )
  return { log, lines, msgs: () => lines.map((l) => JSON.parse(l).msg as string) }
}

const enabled = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  AGENT_ENABLED: '1',
  AGENT_DRY_RUN: '1',
  AGENT_INTERVAL_SECS: '5',
  AGENT_KEYPAIR: keyFile,
  HORAGON_RPC_URL: 'https://api.devnet.solana.com',
  DATABASE_URL: DB_URL,
  ...extra,
})

/** Fake wiring: no RPC, an empty in-memory database. */
function fakeConnect(sender: FakeSender, closed: { n: number }, onNow?: () => void) {
  return async (cfg: AgentConfig, log: pino.Logger) => {
    const { createTestDb } = await import('@horagon/db/testing')
    const h = await createTestDb()
    return {
      deps: {
        db: h.db,
        sender,
        wallet: cfg.agent.publicKey,
        collateralMint: DEVNET_MUSDC_MINT,
        alerts: { send: async () => {} },
        log,
        params: cfg.params,
        dryRun: cfg.dryRun,
        now: () => {
          onNow?.()
          return 1_795_000_000
        },
        faucet: async () => {},
        priorityMicroLamports: 1,
      },
      close: async () => {
        closed.n++
        await h.close()
      },
    }
  }
}

describe('runAgent', () => {
  it('exits 0 with "agent disabled" unless AGENT_ENABLED=1, reading nothing else', async () => {
    for (const env of [
      {},
      { AGENT_ENABLED: '0' },
      { AGENT_ENABLED: 'true', AGENT_KEYPAIR: '/nope' },
    ]) {
      const c = capture()
      expect(await runAgent(env, { log: c.log })).toBe(0)
      expect(c.msgs()).toEqual(['agent disabled'])
    }
  })

  it('refuses to start on a bad configuration', async () => {
    const c = capture()
    const repoDir = listedRepo
    await expect(runAgent(enabled({ AGENT_BAND: '2' }), { log: c.log, repoDir })).rejects.toThrow(
      'AGENT_BAND',
    )
    await expect(
      runAgent(enabled({ AGENT_KEYPAIR: join(dir, 'missing.json') }), { log: c.log, repoDir }),
    ).rejects.toThrow('cannot read the keypair file')
  })

  it('runs dry: rounds go by and nothing is sent; the key and the database URL are never logged', async () => {
    const chain = new FakeChain()
    const sender = new FakeSender(chain.asConnection())
    const closed = { n: 0 }
    const c = capture()
    const code = await runAgent(enabled(), {
      log: c.log,
      connect: fakeConnect(sender, closed),
      maxRounds: 2,
      repoDir: listedRepo,
    })
    expect(code).toBe(0)
    expect(sender.specs).toEqual([])
    expect(closed.n).toBe(1)
    const msgs = c.msgs()
    expect(msgs[0]).toBe('agent started')
    expect(msgs.at(-1)).toBe('agent stopped')
    const started = JSON.parse(c.lines[0] as string)
    expect(started).toMatchObject({ wallet: agent.publicKey.toBase58(), dryRun: true })
    const all = c.lines.join('\n')
    expect(all).not.toContain('SECRETPW')
    expect(all).not.toContain('db.example')
    expect(all).not.toContain(JSON.stringify(Array.from(agent.secretKey)).slice(1, 30))
  })

  it('stops between rounds when its signal aborts', async () => {
    const chain = new FakeChain()
    const sender = new FakeSender(chain.asConnection())
    const closed = { n: 0 }
    const stop = new AbortController()
    const c = capture()
    // The first round asks for the time, and a stop arrives 50 ms later: during the round or
    // during the 5 s sleep after it, which it cuts short.
    let firstRound = 0
    const connect = fakeConnect(sender, closed, () => {
      if (firstRound) return
      firstRound = Date.now()
      setTimeout(() => stop.abort(), 50)
    })
    expect(
      await runAgent(enabled(), { log: c.log, connect, signal: stop.signal, repoDir: listedRepo }),
    ).toBe(0)
    // Well before the 5 s interval: the sleep was cut short.
    expect(Date.now() - firstRound).toBeLessThan(4_000)
    expect(closed.n).toBe(1)
    const stopped = c.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'agent stopped')
    expect(stopped?.rounds).toBe(1)
  })
})

/** Unix seconds of the fake clock in the loop tests below. */
const T0 = 1_795_003_600

/** Wiring on a database the test holds (it outlives runAgent) and a clock it moves. */
function heldConnect(
  db: DbHandle,
  sender: FakeSender,
  nowSecs: () => number,
  seen: { guard?: StallGuard },
) {
  return async (cfg: AgentConfig, log: pino.Logger, guard: StallGuard): Promise<Connected> => {
    seen.guard = guard
    return {
      deps: {
        db: db.db,
        sender,
        wallet: cfg.agent.publicKey,
        collateralMint: DEVNET_MUSDC_MINT,
        alerts: { send: async () => {} },
        log,
        params: cfg.params,
        dryRun: cfg.dryRun,
        now: nowSecs,
        faucet: async () => {},
        priorityMicroLamports: 1,
      },
      close: async () => {},
    }
  }
}

describe("runAgent's loop", () => {
  let h: DbHandle
  beforeAll(async () => {
    const { createTestDb } = await import('@horagon/db/testing')
    h = await createTestDb()
  })
  afterAll(async () => {
    await h.close()
  })

  it('keeps the heartbeat and the stall guard going through a 10 min pause', async () => {
    await h.db.execute('truncate table markets, games, keeper_heartbeats cascade')
    let ms = T0 * 1000
    const chain = new FakeChain()
    const sender = new FakeSender(chain.asConnection())
    await seedLiveMarket(h.db, chain, 1, { now: T0, modelAt: T0 - 5 })
    chain.fail.accounts = new Error('rpc down')
    const seen: { guard?: StallGuard } = {}
    // After each round, as the loop waits for the next one: the stall check, the heartbeat row
    // and the chain reads so far.
    const waits: Array<{ stall: unknown; info: Record<string, unknown>; reads: number }> = []
    const code = await runAgent(enabled({ AGENT_INTERVAL_SECS: '20' }), {
      log: pino({ level: 'silent' }),
      repoDir: listedRepo,
      nowMs: () => ms,
      sleep: async (wait) => {
        ms += wait
        const info = ((await getHeartbeat(h.db, 'agent'))?.info ?? {}) as Record<string, unknown>
        waits.push({ stall: seen.guard?.check() ?? null, info, reads: chain.reads })
        // The RPC answers again once the pause is over.
        if (typeof info.pausedUntil === 'number' && ms / 1000 >= info.pausedUntil) {
          chain.fail.accounts = undefined
        }
      },
      connect: heldConnect(h, sender, () => Math.floor(ms / 1000), seen),
      maxRounds: 35,
    })
    expect(code).toBe(0)
    expect(seen.guard?.stallSecs).toBe(120)
    // Rounds 1 to 5 fail and the fifth starts the 600 s pause; rounds 6 to 34 come every 20 s
    // within it; round 35 comes as it ends.
    expect(waits).toHaveLength(34)
    expect(waits.map((w) => w.info.round)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1))
    // Just before every round, the guard has seen activity within the last 20 s: never a stall.
    expect(waits.map((w) => w.stall)).toEqual(waits.map(() => null))
    const pausedUntil = T0 + 4 * 20 + 600
    for (const w of waits.slice(0, 4)) expect(w.info).toMatchObject({ paused: false })
    for (const w of waits.slice(4)) expect(w.info).toMatchObject({ paused: true, pausedUntil })
    // Paused rounds read nothing from the chain.
    expect(new Set(waits.slice(4).map((w) => w.reads)).size).toBe(1)
    // Round 35 reads again, then the clean stop writes the last row.
    expect(chain.reads).toBeGreaterThan(waits.at(-1)?.reads ?? 0)
    const last = (await getHeartbeat(h.db, 'agent'))?.info
    expect(last).toMatchObject({ round: 35, paused: false, stopped: true })
    expect(last).not.toHaveProperty('pausedUntil')
  })

  it('ends the round in progress on the stop signal before its next send', async () => {
    await h.db.execute('truncate table markets, games, keeper_heartbeats cascade')
    const chain = new FakeChain()
    const sender = new FakeSender(chain.asConnection())
    for (const n of [1, 2, 3]) await seedLiveMarket(h.db, chain, n, { now: T0, modelAt: T0 - 5 })
    const stop = new AbortController()
    // SIGTERM arrives while the first swap is in flight.
    sender.onSend = () => stop.abort()
    const c = capture()
    const code = await runAgent(enabled({ AGENT_DRY_RUN: '0' }), {
      log: c.log,
      repoDir: listedRepo,
      signal: stop.signal,
      connect: heldConnect(h, sender, () => T0, {}),
    })
    expect(code).toBe(0)
    expect(sender.specs).toHaveLength(1)
    const lines = c.lines.map((l) => JSON.parse(l))
    expect(lines.find((l) => l.msg === 'agent round cut short')).toMatchObject({
      reason: 'stop',
      left: 2,
    })
    expect(lines.find((l) => l.msg === 'agent stopped')).toMatchObject({ rounds: 1 })
    expect((await getHeartbeat(h.db, 'agent'))?.info).toMatchObject({ sent: 1, stopped: true })
  })

  it('starts with the markets an unplanned exit left disabled still disabled', async () => {
    await h.db.execute('truncate table markets, games, keeper_heartbeats cascade')
    const chain = new FakeChain()
    const sender = new FakeSender(chain.asConnection())
    const { key } = await seedLiveMarket(h.db, chain, 1, { now: T0, modelAt: T0 - 5 })
    const market = key.toBase58()
    // The last row of a process that died in a round: no `stopped`.
    await heartbeat(h.db, 'agent', { round: 9, paused: false, disabled: [market] })
    const run = async () => {
      const c = capture()
      expect(
        await runAgent(enabled(), {
          log: c.log,
          repoDir: listedRepo,
          connect: heldConnect(h, sender, () => T0, {}),
          maxRounds: 1,
        }),
      ).toBe(0)
      return c.lines.map((l) => JSON.parse(l))
    }
    const first = await run()
    expect(first.find((l) => l.msg.includes('stay disabled'))).toMatchObject({ markets: [market] })
    expect(first.find((l) => l.msg === 'agent skip')).toMatchObject({ reason: 'disabled' })
    // That run stopped cleanly: the next start trades the market again.
    const second = await run()
    expect(second.some((l) => l.msg.includes('stay disabled'))).toBe(false)
    expect(second.find((l) => l.msg === 'agent swap')).toMatchObject({ market, dryRun: true })
  })
})

describe('the disclosure check at start-up', () => {
  const cases: Array<[string, () => string, string]> = [
    ['not listed', () => unlistedRepo, 'not in teamWallets'],
    ['listed with another role', () => otherRoleRepo, 'listed with role sponsor, not team-burner'],
    ['an unreadable file', () => brokenRepo, 'docs/metrics-wallets.json is not valid JSON'],
    ['no file', () => emptyRepo, 'cannot read docs/metrics-wallets.json (ENOENT)'],
  ]

  it.each(cases)('%s: alerts, logs and exits 0 before any read or send', async (_n, repo, why) => {
    for (const dryRun of ['1', '0']) {
      const c = capture()
      const alerts: Array<[string, string]> = []
      let connected = 0
      const code = await runAgent(enabled({ AGENT_DRY_RUN: dryRun }), {
        log: c.log,
        repoDir: repo(),
        alerts: {
          send: async (key, text) => {
            alerts.push([key, text])
          },
        },
        connect: async () => {
          connected++
          throw new Error('must not connect')
        },
      })
      expect(code, dryRun).toBe(0)
      expect(connected, dryRun).toBe(0)
      expect(c.msgs(), dryRun).toEqual([UNLISTED_MSG])
      expect(JSON.parse(c.lines[0] as string)).toMatchObject({
        wallet: agent.publicKey.toBase58(),
        reason: why,
        level: 50,
      })
      expect(
        alerts.map(([k]) => k),
        dryRun,
      ).toEqual(['agent-unlisted'])
      expect(alerts[0]?.[1]).toBe(
        `Reference agent not started: its wallet ${agent.publicKey.toBase58()} is not listed as team-burner in docs/metrics-wallets.json (${why})`,
      )
    }
    expect(UNLISTED_MSG).toBe(
      'agent wallet is not listed as team-burner in docs/metrics-wallets.json',
    )
  })

  it('starts when the wallet is a team-burner entry', async () => {
    const chain = new FakeChain()
    const sender = new FakeSender(chain.asConnection())
    const alerts: string[] = []
    const c = capture()
    const code = await runAgent(enabled(), {
      log: c.log,
      repoDir: listedRepo,
      alerts: {
        send: async (key) => {
          alerts.push(key)
        },
      },
      connect: fakeConnect(sender, { n: 0 }),
      maxRounds: 1,
    })
    expect(code).toBe(0)
    expect(c.msgs()).toContain('agent started')
    expect(c.msgs()).not.toContain(UNLISTED_MSG)
    expect(alerts).not.toContain('agent-unlisted')
  })
})

describe('connectAgent', () => {
  it('wires a sender whose fee payer and only signer is the agent, never the sponsor', async () => {
    const cfg = loadAgentConfig(
      enabled({
        AGENT_DRY_RUN: '0',
        SPONSOR_PUBKEY: sponsor.publicKey.toBase58(),
        HORAGON_RPC_BACKUP_URL: 'https://backup.example',
      }),
      { repoDir: listedRepo },
    )
    const rpcs: Array<ReturnType<typeof recordingConnection> & { url: string }> = []
    const databases: string[] = []
    let closed = 0
    const { deps, close } = await connectAgent(
      cfg,
      pino({ level: 'silent' }),
      new StallGuard(120),
      { send: async () => {} },
      {
        connection: (url) => {
          const rpc = { ...recordingConnection(), url }
          rpcs.push(rpc)
          return rpc.conn
        },
        database: (url) => {
          databases.push(url)
          return {
            db: {} as never,
            close: async () => {
              closed++
            },
          }
        },
      },
    )
    // Both RPCs of the config, verified as devnet, and the keeper's database.
    expect(rpcs.map((r) => r.url)).toEqual([
      'https://api.devnet.solana.com',
      'https://backup.example',
    ])
    expect(databases).toEqual([DB_URL])
    expect(deps.wallet.equals(agent.publicKey)).toBe(true)
    expect(deps.dryRun).toBe(false)
    // The production sender: a swap goes out paid for and signed by the agent alone.
    const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
    await deps.sender.send({
      label: 'swap nba-1',
      instructions: agentSwapInstructions({
        agent: deps.wallet,
        market: deriveMarketPda(7n),
        collateralMint: DEVNET_MUSDC_MINT,
        authority: program.authority,
        direction: 'usdcToYes',
        amountIn: 10_000_000n,
        minOut: 1n,
        createAtas: [],
      }),
      computeUnits: SWAP_COMPUTE_UNITS,
      priorityMicroLamports: 1,
    })
    const sent = rpcs.flatMap((r) => r.sent)
    expect(sent).toHaveLength(1)
    const tx = sent[0] as VersionedTransaction
    const keys: PublicKey[] = tx.message.staticAccountKeys
    expect(keys[0]?.equals(agent.publicKey)).toBe(true)
    expect(tx.message.header.numRequiredSignatures).toBe(1)
    expect(tx.signatures).toHaveLength(1)
    expect(keys.some((k) => k.equals(sponsor.publicKey))).toBe(false)
    // The one signature is the agent's (ed25519 signing is deterministic).
    const resigned = new VTx(tx.message)
    resigned.sign([agent])
    expect(Buffer.from(tx.signatures[0] as Uint8Array)).toEqual(
      Buffer.from(resigned.signatures[0] as Uint8Array),
    )
    await close()
    expect(closed).toBe(1)
  })

  it('refuses an RPC on another cluster before it opens the database', async () => {
    const cfg = loadAgentConfig(enabled(), { repoDir: listedRepo })
    const testnet = {
      ...recordingConnection().conn,
      getGenesisHash: async () => TESTNET_GENESIS_HASH,
    } as unknown as Connection
    let opened = 0
    await expect(
      connectAgent(cfg, pino({ level: 'silent' }), new StallGuard(120), undefined, {
        connection: () => testnet,
        database: () => {
          opened++
          throw new Error('must not open the database')
        },
      }),
    ).rejects.toThrow('genesis hash')
    expect(opened).toBe(0)
    expect(TESTNET_GENESIS_HASH).not.toBe(DEVNET_GENESIS_HASH)
  })
})

describe('agentMain: one page when the agent cannot run', () => {
  /** A fake Telegram that records every message. */
  function telegram() {
    const posts: Array<{ url: string; text: string; chatId: string }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string }
      posts.push({ url: String(url), text: body.text, chatId: body.chat_id })
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch
    return { posts, fetchImpl }
  }
  const withTelegram = (extra: Record<string, string> = {}) =>
    enabled({ TELEGRAM_BOT_TOKEN: 'BOTTOKEN', TELEGRAM_CHAT_ID: '42', ...extra })

  it('pages agent-down for a failed start, once across the restarts systemd makes', async () => {
    const file = join(dir, 'down-start', 'data', 'agent-down.json')
    const { posts, fetchImpl } = telegram()
    const errors: string[] = []
    let now = T0
    // A bad AGENT_* line: the configuration is refused before anything connects.
    const start = () =>
      agentMain(withTelegram({ AGENT_INTERVAL_SECS: '90' }), {
        log: capture().log,
        repoDir: listedRepo,
        error: (line) => errors.push(line),
        down: { file, nowSecs: () => now, fetchImpl },
      })
    expect(await start()).toBe(1)
    expect(errors).toEqual([expect.stringMatching(/^agent failed to start: .*AGENT_INTERVAL_SECS/)])
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toContain('/botBOTTOKEN/sendMessage')
    expect(posts[0]?.chatId).toBe('42')
    expect(posts[0]?.text).toMatch(
      /^\[devnet\] \[agent\] Reference agent failed to start: .*AGENT_INTERVAL_SECS.*It trades nothing until it runs again/,
    )
    // systemd starts it again 10 s later, and again: new processes, no new page.
    for (const later of [10, 20, AGENT_DOWN_REPAGE_SECS - 1]) {
      now = T0 + later
      expect(await start()).toBe(1)
    }
    expect(posts).toHaveLength(1)
    expect(errors).toHaveLength(4)
    // 10 min after the page: the next failure pages again.
    now = T0 + AGENT_DOWN_REPAGE_SECS
    expect(await start()).toBe(1)
    expect(posts).toHaveLength(2)
  })

  it('pages a loop that ends on an error after the start, redacted', async () => {
    const file = join(dir, 'down-run', 'agent-down.json')
    const { posts, fetchImpl } = telegram()
    const errors: string[] = []
    const chain = new FakeChain()
    const sender = new FakeSender(chain.asConnection())
    const inner = fakeConnect(sender, { n: 0 })
    const code = await agentMain(withTelegram(), {
      log: capture().log,
      repoDir: listedRepo,
      maxRounds: 1,
      error: (line) => errors.push(line),
      down: { file, nowSecs: () => T0, fetchImpl },
      connect: async (cfg, log) => {
        const c = await inner(cfg, log)
        return {
          deps: c.deps,
          close: async () => {
            await c.close()
            throw new Error('connection reset: https://rpc.example/?api-key=SECRET')
          },
        }
      },
    })
    expect(code).toBe(1)
    expect(errors).toEqual([expect.stringMatching(/^agent stopped on an error: connection reset/)])
    expect(posts.map((p) => p.text)).toEqual([
      expect.stringMatching(/^\[devnet\] \[agent\] Reference agent stopped on an error: /),
    ])
    expect(JSON.stringify({ errors, posts })).not.toContain('SECRET')
  })

  it('keeps no page time when Telegram did not take the page: the next start pages again', async () => {
    const file = join(dir, 'down-failed', 'agent-down.json')
    const { posts, fetchImpl: ok } = telegram()
    let reachable = false
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!reachable) throw new TypeError('fetch failed')
      return ok(url, init)
    }) as typeof fetch
    let now = T0
    const start = () =>
      agentMain(withTelegram({ AGENT_INTERVAL_SECS: '90' }), {
        log: capture().log,
        repoDir: listedRepo,
        error: () => {},
        down: { file, nowSecs: () => now, fetchImpl },
      })
    // The network is down: nothing delivered, nothing kept.
    expect(await start()).toBe(1)
    expect(posts).toEqual([])
    // systemd's next start, 10 s later, with the network back: it pages.
    reachable = true
    now = T0 + 10
    expect(await start()).toBe(1)
    expect(posts).toHaveLength(1)
    // And that page holds the next ones back as before.
    now = T0 + 20
    expect(await start()).toBe(1)
    expect(posts).toHaveLength(1)
  })

  it('does not page a stop by hand whose close fails after the stop signal', async () => {
    const file = join(dir, 'down-stop', 'agent-down.json')
    const { posts, fetchImpl } = telegram()
    const errors: string[] = []
    const chain = new FakeChain()
    const sender = new FakeSender(chain.asConnection())
    const inner = fakeConnect(sender, { n: 0 })
    const stop = new AbortController()
    const code = await agentMain(withTelegram(), {
      log: capture().log,
      repoDir: listedRepo,
      signal: stop.signal,
      onStarted: () => stop.abort(),
      error: (line) => errors.push(line),
      down: { file, nowSecs: () => T0, fetchImpl },
      connect: async (cfg, log) => {
        const c = await inner(cfg, log)
        return {
          deps: c.deps,
          close: async () => {
            await c.close()
            throw new Error('connection reset')
          },
        }
      },
    })
    expect(code).toBe(1)
    expect(errors).toEqual([expect.stringMatching(/^agent stopped on an error: connection reset/)])
    expect(posts).toEqual([])
  })

  it('writes the journal line only when Telegram is not set, and exits 0 when it runs', async () => {
    const file = join(dir, 'down-none', 'agent-down.json')
    const { posts, fetchImpl } = telegram()
    const errors: string[] = []
    const opts = {
      log: capture().log,
      repoDir: listedRepo,
      error: (line: string) => errors.push(line),
      down: { file, nowSecs: () => T0, fetchImpl },
    }
    expect(await agentMain(enabled({ AGENT_BAND: '2' }), opts)).toBe(1)
    expect(errors).toEqual([expect.stringMatching(/^agent failed to start: .*AGENT_BAND/)])
    expect(posts).toEqual([])
    // A disabled agent is no failure: exit 0, no line, no page.
    expect(await agentMain({}, opts)).toBe(0)
    expect(errors).toHaveLength(1)
    expect(posts).toEqual([])
  })
})
