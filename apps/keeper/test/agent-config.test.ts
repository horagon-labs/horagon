import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEVNET_MUSDC_MINT } from '@horagon/sdk'
import { Keypair } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentEnabled,
  agentLogLevel,
  defaultAgentParams,
  loadAgentConfig,
} from '../src/agent/config'
import { REPO_DIR } from '../src/config'

let dir: string
let keyFile: string
const agent = Keypair.generate()
const DB_URL = 'postgres://agent:SECRETPW@db.example:5432/horagon'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'horagon-agent-config-'))
  keyFile = join(dir, 'agent.json')
  await writeFile(keyFile, JSON.stringify(Array.from(agent.secretKey)))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  AGENT_ENABLED: '1',
  HORAGON_RPC_URL: 'https://api.devnet.solana.com',
  DATABASE_URL: DB_URL,
  AGENT_KEYPAIR: keyFile,
  ...extra,
})

const M = 1_000_000n

/** The error message of a config that must be refused. */
function refusal(extra: Record<string, string>): string {
  try {
    loadAgentConfig(env(extra))
  } catch (err) {
    return (err as Error).message
  }
  throw new Error(`accepted: ${JSON.stringify(extra)}`)
}

describe('agentEnabled', () => {
  it('is on for AGENT_ENABLED=1 only', () => {
    expect(agentEnabled({ AGENT_ENABLED: '1' })).toBe(true)
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(agentEnabled({ AGENT_ENABLED: v }), String(v)).toBe(false)
    }
  })

  it('reads LOG_LEVEL before the config, falling back to info', () => {
    expect(agentLogLevel({ LOG_LEVEL: 'debug' })).toBe('debug')
    expect(agentLogLevel({ LOG_LEVEL: 'loud' })).toBe('info')
    expect(agentLogLevel({})).toBe('info')
  })
})

describe('loadAgentConfig', () => {
  it('has the brief defaults', () => {
    const c = loadAgentConfig(env())
    expect(c.params).toEqual({
      intervalSecs: 20,
      practice: false,
      fanLagSecs: 90,
      modelMaxAgeSecs: 60,
      endBufferSecs: 120,
      band: 0.04,
      stopShort: 0.02,
      tolerance: 0.005,
      slippageBps: 200,
      maxPerSwap: 100n * M,
      maxPerGame: 2_000n * M,
      minSwap: 1n * M,
      maxSwapsPerGame: 40,
      maxFailures: 5,
      pauseSecs: 600,
      minSolLamports: 100_000_000n,
      minMusdc: 200n * M,
    })
    expect(c.params).toEqual(defaultAgentParams())
    expect(c.dryRun).toBe(false)
    expect(c.agent.publicKey.equals(agent.publicKey)).toBe(true)
    expect(c.rpcs).toEqual([{ url: 'https://api.devnet.solana.com' }])
    expect(c.cluster).toBe('devnet')
    expect(c.databaseUrl).toBe(DB_URL)
    expect(c.collateralMint.equals(DEVNET_MUSDC_MINT)).toBe(true)
    expect(c.telegram).toBeNull()
    expect(c.faucetUrl).toBe('https://pm-amm-devnet.vercel.app/api/faucet')
    expect(c.priorityMicroLamports).toBe(10_000)
    expect(c.stallSecs).toBe(120)
  })

  it('takes every AGENT_* override, and an empty value as unset', () => {
    const c = loadAgentConfig(
      env({
        AGENT_DRY_RUN: '1',
        AGENT_PRACTICE: '1',
        AGENT_INTERVAL_SECS: '30',
        AGENT_FAN_LAG_SECS: '120',
        AGENT_MODEL_MAX_AGE_SECS: '45',
        AGENT_END_BUFFER_SECS: '300',
        AGENT_BAND: '0.05',
        AGENT_STOP_SHORT: '0.01',
        AGENT_TOLERANCE: '0.004',
        AGENT_SLIPPAGE_BPS: '150',
        AGENT_MAX_PER_SWAP: '50.5',
        AGENT_MAX_PER_GAME: '500',
        AGENT_MAX_SWAPS_PER_GAME: '10',
        AGENT_MIN_SWAP: '2',
        AGENT_MAX_FAILURES: '3',
        AGENT_PAUSE_SECS: '900',
        AGENT_MIN_SOL: '0.25',
        AGENT_MIN_MUSDC: '50',
        HORAGON_RPC_BACKUP_URL: 'https://devnet.helius-rpc.com/?api-key=k',
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_CHAT_ID: 'c',
        PRIORITY_MICROLAMPORTS: '5000',
      }),
    )
    expect(c.dryRun).toBe(true)
    expect(c.params).toMatchObject({
      intervalSecs: 30,
      practice: true,
      fanLagSecs: 120,
      modelMaxAgeSecs: 45,
      endBufferSecs: 300,
      band: 0.05,
      stopShort: 0.01,
      tolerance: 0.004,
      slippageBps: 150,
      maxPerSwap: 50_500_000n,
      maxPerGame: 500n * M,
      maxSwapsPerGame: 10,
      minSwap: 2n * M,
      maxFailures: 3,
      pauseSecs: 900,
      minSolLamports: 250_000_000n,
      minMusdc: 50n * M,
    })
    expect(c.rpcs).toHaveLength(2)
    expect(c.telegram).toEqual({ token: 't', chatId: 'c' })
    expect(c.priorityMicroLamports).toBe(5_000)
    expect(loadAgentConfig(env({ AGENT_BAND: '', AGENT_DRY_RUN: '' })).params.band).toBe(0.04)
  })

  it('resolves a relative AGENT_KEYPAIR from the repo root', () => {
    const c = loadAgentConfig(env({ AGENT_KEYPAIR: 'agent.json' }), { repoDir: dir })
    expect(c.agent.publicKey.equals(agent.publicKey)).toBe(true)
  })

  it('reads the wallets file at that same repo root', () => {
    const c = loadAgentConfig(env({ AGENT_KEYPAIR: 'agent.json' }), { repoDir: dir })
    expect(c.walletsFile).toBe(join(dir, 'docs', 'metrics-wallets.json'))
    // By default, the repo this code runs from (the deploy ships the whole tree).
    const shipped = loadAgentConfig(env())
    expect(shipped.walletsFile).toBe(join(REPO_DIR, 'docs', 'metrics-wallets.json'))
  })

  it('refuses values out of range', () => {
    for (const [name, value] of [
      ['AGENT_DRY_RUN', 'yes'],
      ['AGENT_PRACTICE', '2'],
      ['AGENT_INTERVAL_SECS', '1'],
      ['AGENT_INTERVAL_SECS', '2.5'],
      ['AGENT_FAN_LAG_SECS', '-1'],
      ['AGENT_MODEL_MAX_AGE_SECS', '0'],
      ['AGENT_END_BUFFER_SECS', '30'],
      ['AGENT_BAND', '0'],
      ['AGENT_BAND', '0.6'],
      ['AGENT_STOP_SHORT', '-0.01'],
      ['AGENT_TOLERANCE', '0'],
      ['AGENT_SLIPPAGE_BPS', '0'],
      ['AGENT_SLIPPAGE_BPS', '5000'],
      ['AGENT_MAX_PER_SWAP', '0'],
      ['AGENT_MAX_PER_SWAP', 'lots'],
      ['AGENT_MAX_PER_SWAP', '1.0000001'],
      ['AGENT_MAX_PER_GAME', '-5'],
      ['AGENT_MAX_SWAPS_PER_GAME', '0'],
      ['AGENT_MIN_SWAP', '0'],
      ['AGENT_MAX_FAILURES', '0'],
      ['AGENT_PAUSE_SECS', '10'],
      ['AGENT_MIN_SOL', '-1'],
      ['AGENT_MIN_MUSDC', '-1'],
    ] as const) {
      expect(refusal({ [name]: value }), `${name}=${value}`).toContain(name)
    }
  })

  it('refuses parameters that contradict each other', () => {
    expect(refusal({ AGENT_STOP_SHORT: '0.04' })).toContain('under AGENT_BAND')
    expect(refusal({ AGENT_STOP_SHORT: '0.035', AGENT_TOLERANCE: '0.005' })).toContain(
      'under AGENT_BAND',
    )
    expect(refusal({ AGENT_MIN_SWAP: '200' })).toContain('AGENT_MIN_SWAP must not exceed')
    expect(refusal({ AGENT_MAX_PER_SWAP: '3000' })).toContain('AGENT_MAX_PER_SWAP must not exceed')
    expect(refusal({ AGENT_INTERVAL_SECS: '60', KEEPER_STALL_SECS: '100' })).toContain(
      'half of KEEPER_STALL_SECS',
    )
  })

  it('refuses a missing RPC or database, a mainnet RPC and a half-set Telegram', () => {
    expect(refusal({ HORAGON_RPC_URL: '' })).toContain('HORAGON_RPC_URL')
    expect(refusal({ DATABASE_URL: '' })).toContain('DATABASE_URL')
    expect(refusal({ HORAGON_RPC_URL: 'https://api.mainnet-beta.solana.com' })).toContain(
      'devnet only',
    )
    expect(refusal({ TELEGRAM_BOT_TOKEN: 't' })).toContain('set together')
  })

  it('refuses to run as the sponsor', () => {
    expect(refusal({ SPONSOR_PUBKEY: agent.publicKey.toBase58() })).toContain('is the sponsor')
    const other = Keypair.generate().publicKey.toBase58()
    expect(() => loadAgentConfig(env({ SPONSOR_PUBKEY: other }))).not.toThrow()
  })

  it('names the keypair file, never its content or the database URL', async () => {
    expect(refusal({ AGENT_KEYPAIR: join(dir, 'missing.json') })).toContain('cannot read')
    const bad = join(dir, 'bad.json')
    await writeFile(bad, JSON.stringify(Array.from(agent.secretKey).slice(0, 40)))
    const message = refusal({ AGENT_KEYPAIR: bad })
    expect(message).toContain(bad)
    expect(message).not.toMatch(/\d{1,3},\d{1,3},\d{1,3}/)
    const extras: Array<Record<string, string>> = [{ AGENT_BAND: '9' }, { HORAGON_RPC_URL: 'nope' }]
    for (const extra of extras) {
      expect(refusal(extra)).not.toContain('SECRETPW')
    }
  })
})
