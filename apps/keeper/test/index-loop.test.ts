// The indexer runs on a loop of its own (main.ts): an index read that hangs (an RPC that never
// answers until its 15 s timeout) must not hold the tick, whose halts are due on time. The tick
// is a fake that counts its rounds; the index round is the real indexOnce over IndexReads, on a
// test database, whose account read hangs until released.
import { type DbHandle, upsertMarket, upsertScheduledGames } from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { DEVNET_MUSDC_MINT, HoragonProgram } from '@horagon/sdk'
import { Keypair } from '@solana/web3.js'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IndexPace } from '../src/index-pace'
import { IndexReads } from '../src/index-reads'
import { type IndexerDeps, indexOnce } from '../src/indexer'
import { PeriodicLoop, runStep } from '../src/loop'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Waits for `cond`, failing after `ms` (real time: generous, so a busy machine passes). */
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(5)
  }
}

describe('the index loop', () => {
  const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
  const log = pino({ level: 'silent' })
  let h: DbHandle

  beforeEach(async () => {
    h = await createTestDb()
    await upsertScheduledGames(h.db, [
      {
        id: 'nba-1',
        league: 'NBA',
        externalId: '1',
        gameDate: '2026-11-27',
        home: 'WAS',
        away: 'MEM',
        scheduledTipoff: new Date(Date.now() + 3_600_000),
        status: 'scheduled',
        p0: 0.5,
      },
    ])
    await upsertMarket(h.db, {
      pubkey: Keypair.generate().publicKey.toBase58(),
      gameId: 'nba-1',
      kind: 0,
      marketId: 'open-0',
      gameMarketPda: Keypair.generate().publicKey.toBase58(),
      yesMint: Keypair.generate().publicKey.toBase58(),
      noMint: Keypair.generate().publicKey.toBase58(),
      initialPriceBps: 5000,
      endTs: new Date(Date.now() + 7_200_000),
      seedAmount: 1_000_000n,
      status: 'open',
    })
  })
  afterEach(async () => {
    await h.close()
  })

  it('keeps the tick on its cadence while an index read hangs', async () => {
    let release: () => void = () => {}
    const hung = new Promise<void>((r) => (release = r))
    let accountReads = 0
    const connection = {
      getMultipleAccountsInfo: async (keys: unknown[]) => {
        accountReads++
        await hung
        return keys.map(() => null)
      },
      getSignaturesForAddress: async () => [],
      getTransactions: async () => [],
    } as unknown as NonNullable<IndexerDeps['connection']>
    const reads = new IndexReads({
      endpoints: [
        {
          name: 'HORAGON_RPC_URL',
          host: 'rpc.test',
          connection: () => connection,
          pace: new IndexPace({ log }),
        },
      ],
      log,
      alerts: { send: async () => {} },
    })
    let stopping = false
    const ticks: number[] = []
    const tickLoop = new PeriodicLoop({
      periodMs: 20,
      stopping: () => stopping,
      round: async () => {
        await runStep(log, 'tick', async () => ticks.push(Date.now()))
      },
    })
    const indexLoop = new PeriodicLoop({
      periodMs: 20,
      stopping: () => stopping,
      round: async () => {
        await runStep(log, 'index', () =>
          indexOnce({
            db: h.db,
            reads,
            collateralMint: DEVNET_MUSDC_MINT,
            authority: program.authority,
            alerts: { send: async () => {} },
            log,
            now: () => Math.floor(Date.now() / 1000),
            stops: new Map(),
          }),
        )
      },
    })
    const done = Promise.all([tickLoop.run(), indexLoop.run()])
    // The index pass reaches its account read, which hangs ...
    await until(() => accountReads === 1)
    const before = ticks.length
    // ... and the tick goes on round after round meanwhile.
    await until(() => ticks.length >= before + 10)
    expect(accountReads).toBe(1)
    expect(indexLoop.rounds).toBe(0)
    expect(indexLoop.busyMs()).toBeGreaterThan(0)

    stopping = true
    tickLoop.wake()
    indexLoop.wake()
    release()
    await done
    expect(indexLoop.rounds).toBe(1)
  }, 30_000)

  it('for contrast: the old round, the tick then the indexer, held the tick behind the hang', async () => {
    let release: () => void = () => {}
    const hung = new Promise<void>((r) => (release = r))
    let stopping = false
    const ticks: number[] = []
    const round = new PeriodicLoop({
      periodMs: 20,
      stopping: () => stopping,
      round: async () => {
        await runStep(log, 'tick', async () => ticks.push(Date.now()))
        await runStep(log, 'index', () => hung)
      },
    })
    const done = round.run()
    await sleep(300)
    expect(ticks).toHaveLength(1)
    stopping = true
    release()
    await done
  })
})
