import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  countTradesWithoutBotMemo,
  type DbHandle,
  insertTrades,
  listMarketTrades,
  setTradeBotMemo,
  tradeSigsWithoutBotMemo,
} from '../src'
import { createTestDb } from '../src/testing'

let h: DbHandle
beforeAll(async () => {
  h = await createTestDb()
})
beforeEach(async () => {
  await h.db.execute(sql`truncate table trades`)
})
afterAll(async () => {
  await h.close()
})

/** A trade row; without `botMemo` it is a row indexed before the column existed. */
const trade = (sig: string, ixIndex: number, minute: number, botMemo?: boolean) => ({
  sig,
  ixIndex,
  market: 'M1',
  wallet: 'W1',
  direction: 'usdcToYes',
  usdcAmount: 1n,
  usdcDelta: -1n,
  yesDelta: 1n,
  noDelta: 0n,
  fee: 0n,
  slot: BigInt(minute),
  blockTime: new Date(Date.UTC(2026, 10, 26, 1, minute)),
  ...(botMemo === undefined ? {} : { botMemo }),
})

const memos = async () =>
  (await listMarketTrades(h.db, ['M1'])).map((t) => [t.sig, t.ixIndex, t.botMemo])

describe('trades.bot_memo', () => {
  it('stores true, false, or null for a row indexed before the column', async () => {
    await insertTrades(h.db, [trade('A', 2, 1, true), trade('B', 2, 2, false), trade('C', 2, 3)])
    expect(await memos()).toEqual([
      ['A', 2, true],
      ['B', 2, false],
      ['C', 2, null],
    ])
  })

  it('lists the unset transactions oldest first, once each, up to the limit', async () => {
    await insertTrades(h.db, [
      trade('C', 2, 3),
      trade('A', 2, 1),
      trade('A', 3, 1),
      trade('B', 2, 2, true),
      trade('D', 2, 4),
    ])
    expect(await tradeSigsWithoutBotMemo(h.db, 10)).toEqual(['A', 'C', 'D'])
    expect(await tradeSigsWithoutBotMemo(h.db, 2)).toEqual(['A', 'C'])
    expect(await countTradesWithoutBotMemo(h.db)).toBe(3)
  })

  it('sets every unset row of a transaction and never overwrites a set one', async () => {
    await insertTrades(h.db, [trade('A', 2, 1), trade('A', 3, 1), trade('B', 2, 2, false)])
    expect(await setTradeBotMemo(h.db, 'A', true)).toBe(2)
    expect(await setTradeBotMemo(h.db, 'B', true)).toBe(0)
    expect(await setTradeBotMemo(h.db, 'A', false)).toBe(0)
    expect(await memos()).toEqual([
      ['A', 2, true],
      ['A', 3, true],
      ['B', 2, false],
    ])
    expect(await countTradesWithoutBotMemo(h.db)).toBe(0)
  })
})
