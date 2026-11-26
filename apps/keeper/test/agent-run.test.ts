import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
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
import { connectAgent, runAgent, UNLISTED_MSG } from '../src/agent/run'
import { agentSwapInstructions } from '../src/agent/tx'
import { DEVNET_GENESIS_HASH } from '../src/config'
import { StallGuard } from '../src/stall'
import { FakeChain, FakeSender, recordingConnection } from './agent-fixtures'

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
