import { Buffer } from 'node:buffer'
import {
  DEVNET_MUSDC_MINT,
  isBotMemoInstruction,
  MEMO_PROGRAM_ID,
  PROTOCOL_DAO,
} from '@horagon/sdk'
import { VersionedTransaction } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { DEFAULT_SPONSOR_LIMITS } from '../src/sponsor/policy'
import { MarketSet } from '../src/sponsor/submit'
import { validateSponsoredTransaction } from '../src/sponsor/validate'
import { makeEnv, program, type TestEnv } from './helpers'

let env: TestEnv
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  env = await makeEnv()
  app = createApp(env.deps)
})
afterEach(async () => {
  await env.h.close()
})

const trade = (extra: Record<string, unknown> = {}) =>
  app.request('/api/v1/tx/trade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      market: env.market.pubkey.toBase58(),
      side: 'home',
      action: 'buy',
      amount: '20',
      wallet: env.user.publicKey.toBase58(),
      ...extra,
    }),
  })

async function built(extra: Record<string, unknown> = {}): Promise<VersionedTransaction> {
  const res = await trade(extra)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { tx: string }
  return VersionedTransaction.deserialize(Buffer.from(body.tx, 'base64'))
}

const memosOf = (tx: VersionedTransaction) =>
  tx.message.compiledInstructions.filter((ix) =>
    tx.message.staticAccountKeys[ix.programIdIndex]?.equals(MEMO_PROGRAM_ID),
  )

async function verdictOf(tx: VersionedTransaction) {
  const set = new MarketSet(env.deps)
  await set.refresh(true)
  return validateSponsoredTransaction(tx, {
    sponsor: env.sponsor.publicKey,
    collateralMint: DEVNET_MUSDC_MINT,
    feeOwners: [PROTOCOL_DAO, program.authority],
    isHoragonMarket: (k) => set.hasMarket(k),
    outcomeMintMarket: (k) => set.marketOfMint(k),
    limits: DEFAULT_SPONSOR_LIMITS,
  })
}

describe('POST /tx/trade with client "bot"', () => {
  it('adds exactly one horagon:bot memo, which the sponsor validator accepts', async () => {
    const tx = await built({ client: 'bot' })
    const memos = memosOf(tx)
    expect(memos).toHaveLength(1)
    const [memo] = memos
    expect(
      memo !== undefined &&
        isBotMemoInstruction(MEMO_PROGRAM_ID, memo.accountKeyIndexes.length, memo.data),
    ).toBe(true)
    expect(await verdictOf(tx)).toMatchObject({ ok: true, user: env.user.publicKey })
  })

  it('adds no memo without a client', async () => {
    const tx = await built()
    expect(memosOf(tx)).toEqual([])
    expect((await verdictOf(tx)).ok).toBe(true)
  })

  it.each(['web', 'BOT', ''])('refuses client %j with INVALID_INPUT', async (client) => {
    const res = await trade({ client })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_INPUT')
  })
})
