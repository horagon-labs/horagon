#!/usr/bin/env node
// Checks the README's devnet claims against public Solana devnet RPC. Read-only: it sends no
// transaction, holds no key, and needs no install or build. Node 22 or later.
//
//   node scripts/check-claims.mjs [--rpc <url>]
//
// Every expected value comes from a file committed in this repository: the spike results in
// spikes/results/ and the swap fixture packages/sdk/test/fixtures/s1-swaps.json.

import { readFileSync } from 'node:fs'

const PM_AMM = 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y'
const MUSDC = '3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ'
const MARKET_ACCOUNT_SPACE = 443

const args = process.argv.slice(2)
const rpcAt = args.indexOf('--rpc')
const RPC = rpcAt >= 0 ? args[rpcAt + 1] : 'https://api.devnet.solana.com'

const root = new URL('../', import.meta.url)
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const s1 = readJson('spikes/results/s1-devnet-2026-11-18T09-13-42-490Z.json').data
const s3a = readJson('spikes/results/s3a-sponsor-2026-11-18T09-30-55-777Z.json').data
const s5 = readJson('spikes/results/s5-faucet-2026-11-18T06-02-18-766Z.json').data
const fixture = readJson('packages/sdk/test/fixtures/s1-swaps.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let requestId = 0

async function rpc(method, params) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    })
    if (res.status === 429 && attempt < 6) {
      await sleep(1_000 * attempt)
      continue
    }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
    const body = await res.json()
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    return body.result
  }
}

async function getTx(signature) {
  await sleep(250)
  const tx = await rpc('getTransaction', [
    signature,
    { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
  ])
  if (!tx) throw new Error(`transaction ${signature} not found`)
  return tx
}

const accountKeys = (tx) => tx.transaction.message.accountKeys
const invokes = (tx, program) => accountKeys(tx).includes(program)
const solChange = (tx, account) => {
  const i = accountKeys(tx).indexOf(account)
  return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i])
}

/** Raw token balance changes of the accounts `owner` owns, keyed by mint. */
function tokenChanges(tx, owner) {
  const changes = new Map()
  const add = (balances, sign) => {
    for (const b of balances ?? []) {
      if (b.owner !== owner) continue
      const prev = changes.get(b.mint) ?? 0n
      changes.set(b.mint, prev + sign * BigInt(b.uiTokenAmount.amount))
    }
  }
  add(tx.meta.preTokenBalances, -1n)
  add(tx.meta.postTokenBalances, 1n)
  return changes
}

const results = []
async function claim(name, check) {
  try {
    const detail = await check()
    results.push(true)
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    results.push(false)
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, chain says ${actual}`)
}

const cited = [
  s1.create.signature,
  ...fixture.swaps.map((s) => s.signature),
  s1.claimLpResidualsMidLife.signature,
  s1.withdrawAll.signature,
  s1.resolve.signature,
  s1['trader.claim'].signature,
  s1['creator.claim'].signature,
  s3a.sponsoredSwap.body.signature,
  s5['creator.faucet'].body.signature,
  s5['trader.faucet'].body.signature,
]

console.log(`Reading ${RPC}\n`)

await claim(
  `all ${cited.length} cited devnet transactions are finalized without error`,
  async () => {
    const { value } = await rpc('getSignatureStatuses', [cited, { searchTransactionHistory: true }])
    value.forEach((status, i) => {
      if (!status) throw new Error(`${cited[i]} not found`)
      if (status.err) throw new Error(`${cited[i]} failed: ${JSON.stringify(status.err)}`)
      if (status.confirmationStatus !== 'finalized') throw new Error(`${cited[i]} not finalized`)
    })
  },
)

await claim('S1: one transaction created and seeded the market through pm-AMM', async () => {
  const tx = await getTx(s1.create.signature)
  if (!invokes(tx, PM_AMM)) throw new Error('pm-AMM is not in the transaction')
  expectEqual(tx.meta.computeUnitsConsumed, s1.create.computeUnits, 'compute units')
  expectEqual(tx.meta.fee, s1.create.feeLamports, 'fee')
  return `${tx.meta.computeUnitsConsumed.toLocaleString('en-US')} CU`
})

await claim('S1: the market account is a pm-AMM Market', async () => {
  const { value } = await rpc('getAccountInfo', [s1.market, { encoding: 'base64' }])
  if (!value) throw new Error(`${s1.market} not found`)
  expectEqual(value.owner, PM_AMM, 'owner')
  expectEqual(Buffer.from(value.data[0], 'base64').length, MARKET_ACCOUNT_SPACE, 'size')
  return s1.market
})

for (const swap of fixture.swaps) {
  await claim(`S1: the ${swap.direction} swap paid what the quote test replays`, async () => {
    const tx = await getTx(swap.signature)
    if (!invokes(tx, PM_AMM)) throw new Error('pm-AMM is not in the transaction')
    const gains = [...tokenChanges(tx, accountKeys(tx)[0]).values()].filter((d) => d > 0n)
    if (gains.length !== 1) throw new Error(`expected one balance to rise, got ${gains.length}`)
    expectEqual(gains[0].toString(), swap.actualOut, 'raw amount out')
    return `${swap.actualOut} raw out`
  })
}

for (const who of ['trader', 'creator']) {
  await claim(`S1: the ${who}'s claim_winnings paid 1 mUSDC per winning share`, async () => {
    const recorded = s1[`${who}.claim`]
    const tx = await getTx(recorded.signature)
    const changes = tokenChanges(tx, accountKeys(tx)[0])
    const paid = changes.get(MUSDC) ?? 0n
    // The claim burns the winning and the losing shares; only the winning side pays.
    const burned = [...changes.entries()].filter(([m, d]) => m !== MUSDC && d < 0n)
    if (!burned.some(([, d]) => -d === paid)) {
      throw new Error(`paid ${paid}, which matches no burned share balance`)
    }
    expectEqual(paid.toString(), String(recorded.paid), 'raw mUSDC paid')
    return `${paid} raw for ${paid} winning shares`
  })
}

await claim('S3a: a burner with 0 SOL swapped, and the sponsor paid every lamport', async () => {
  const tx = await getTx(s3a.sponsoredSwap.body.signature)
  const [sponsor, burner] = accountKeys(tx)
  expectEqual(tx.transaction.message.header.numRequiredSignatures, 2, 'signers')
  const i = accountKeys(tx).indexOf(burner)
  expectEqual(tx.meta.preBalances[i], 0, 'burner SOL before')
  expectEqual(tx.meta.postBalances[i], 0, 'burner SOL after')
  expectEqual(-solChange(tx, sponsor), BigInt(s3a.sponsorCostLamports), 'sponsor lamports spent')
  expectEqual(tx.meta.computeUnitsConsumed, s3a.sponsoredSwapStats.computeUnits, 'compute units')
  const shares = [...tokenChanges(tx, burner).entries()].filter(([m, d]) => m !== MUSDC && d > 0n)
  if (shares.length !== 1) throw new Error('the burner received no outcome shares')
  return `burner ${burner}, sponsor spent ${s3a.sponsorCostLamports} lamports`
})

for (const who of ['creator', 'trader']) {
  await claim(`S5: the faucet paid the ${who} exactly 1,000 mUSDC and no SOL`, async () => {
    const wallet = s5[`${who}.wallet`]
    const tx = await getTx(s5[`${who}.faucet`].body.signature)
    expectEqual(tokenChanges(tx, wallet).get(MUSDC), 1_000_000_000n, 'raw mUSDC received')
    if (accountKeys(tx).includes(wallet)) expectEqual(solChange(tx, wallet), 0n, 'SOL received')
    return wallet
  })
}

const passed = results.filter(Boolean).length
console.log(`\n${passed} of ${results.length} claims hold`)
process.exitCode = passed === results.length ? 0 : 1
