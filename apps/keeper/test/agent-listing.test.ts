import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { teamBurnerListing, WALLETS_FILE } from '../src/agent/listing'
import { REPO_DIR } from '../src/config'

let dir: string
const agent = Keypair.generate().publicKey.toBase58()
const other = Keypair.generate().publicKey.toBase58()

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'horagon-agent-listing-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

let n = 0
/** A wallets file with `text` as its content; its path. */
async function file(text: string): Promise<string> {
  const path = join(dir, `wallets-${n++}.json`)
  await writeFile(path, text)
  return path
}

const wallets = (teamWallets: unknown) =>
  JSON.stringify({ version: 1, teamWallets, excludedMarkets: [] })

describe('teamBurnerListing', () => {
  it('accepts the wallet when it is a team-burner entry', async () => {
    const path = await file(
      wallets([
        { pubkey: other, role: 'attestor', addedAt: '2026-11-26' },
        { pubkey: agent, role: 'team-burner', addedAt: '2026-11-26' },
      ]),
    )
    expect(teamBurnerListing(agent, path)).toEqual({ listed: true })
  })

  it('refuses a wallet that is not listed, or listed with another role', async () => {
    const path = await file(
      wallets([
        { pubkey: other, role: 'team-burner', addedAt: '2026-11-26' },
        { pubkey: agent, role: 'attestor', addedAt: '2026-11-26' },
      ]),
    )
    expect(teamBurnerListing(agent, path)).toEqual({
      listed: false,
      reason: 'listed with role attestor, not team-burner',
    })
    const missing = Keypair.generate().publicKey.toBase58()
    expect(teamBurnerListing(missing, path)).toEqual({
      listed: false,
      reason: 'not in teamWallets',
    })
    // An entry with no role (or an empty or non-text one) says so.
    for (const entry of [
      { pubkey: agent },
      { pubkey: agent, role: '' },
      { pubkey: agent, role: 7 },
    ]) {
      const path = await file(wallets([entry]))
      expect(teamBurnerListing(agent, path), JSON.stringify(entry)).toEqual({
        listed: false,
        reason: 'listed without a role, not team-burner',
      })
    }
  })

  it('treats a missing, unreadable or malformed file as not listed', async () => {
    expect(teamBurnerListing(agent, join(dir, 'nope.json'))).toEqual({
      listed: false,
      reason: `cannot read ${WALLETS_FILE} (ENOENT)`,
    })
    // A directory where the file should be cannot be read either.
    const folder = join(dir, 'a-folder.json')
    await mkdir(folder)
    expect(teamBurnerListing(agent, folder)).toMatchObject({ listed: false })
    expect(teamBurnerListing(agent, await file('{"teamWallets": ['))).toEqual({
      listed: false,
      reason: `${WALLETS_FILE} is not valid JSON`,
    })
    for (const text of ['null', '[]', '{}', '{"teamWallets": {}}']) {
      expect(teamBurnerListing(agent, await file(text)), text).toEqual({
        listed: false,
        reason: `${WALLETS_FILE} has no teamWallets list`,
      })
    }
    // Entries that are not objects are skipped, not fatal.
    expect(
      teamBurnerListing(agent, await file(wallets([null, 7, { pubkey: agent }]))),
    ).toMatchObject({ listed: false })
  })

  it('lists the reference agent wallet in the shipped file', () => {
    // The wallet created on the VPS for the agent (README, "Reference agent").
    expect(
      teamBurnerListing(
        '7Da24CpktL9Cp4st1iQ3U4ZKHgsRYXXEJx5oGbgFWP1Z',
        join(REPO_DIR, WALLETS_FILE),
      ),
    ).toEqual({ listed: true })
  })
})
