import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { DEVNET_MUSDC_MINT } from '@horagon/sdk'
import { Keypair } from '@solana/web3.js'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentConfig } from '../src/agent/config'
import { runAgent } from '../src/agent/run'
import { FakeChain, FakeSender } from './agent-fixtures'

let dir: string
let keyFile: string
const agent = Keypair.generate()
const DB_URL = 'postgres://agent:SECRETPW@db.example:5432/horagon'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'horagon-agent-run-'))
  keyFile = join(dir, 'agent.json')
  await writeFile(keyFile, JSON.stringify(Array.from(agent.secretKey)))
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
    await expect(runAgent(enabled({ AGENT_BAND: '2' }), { log: c.log })).rejects.toThrow(
      'AGENT_BAND',
    )
    await expect(
      runAgent(enabled({ AGENT_KEYPAIR: join(dir, 'missing.json') }), { log: c.log }),
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
    expect(await runAgent(enabled(), { log: c.log, connect, signal: stop.signal })).toBe(0)
    // Well before the 5 s interval: the sleep was cut short.
    expect(Date.now() - firstRound).toBeLessThan(4_000)
    expect(closed.n).toBe(1)
    const stopped = c.lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'agent stopped')
    expect(stopped?.rounds).toBe(1)
  })
})
