// A Horagon Config account as the chain holds it, for tests that read the dispute window
// (R7's /me, R6 part B's game page). Not in helpers.ts: that file is shared with other tasks.
import { Buffer } from 'node:buffer'
import { DEVNET_MUSDC_MINT, HORAGON_ACCOUNT_DISCRIMINATORS } from '@horagon/sdk'
import { type AccountInfo, Keypair } from '@solana/web3.js'
import { program } from './helpers'

/** Borsh: discriminator, admin, attestor, 2 guardians, u32 window, mint, paused, bump. */
export function configAccount(disputeWindowSecs: number): AccountInfo<Buffer> {
  const data = Buffer.alloc(8 + 32 * 4 + 4 + 32 + 1 + 1)
  data.set(HORAGON_ACCOUNT_DISCRIMINATORS.Config, 0)
  let at = 8
  for (let i = 0; i < 4; i++) {
    data.set(Keypair.generate().publicKey.toBytes(), at)
    at += 32
  }
  data.writeUInt32LE(disputeWindowSecs, at)
  at += 4
  data.set(DEVNET_MUSDC_MINT.toBytes(), at)
  at += 32
  data[at] = 0
  data[at + 1] = 254
  return { data, owner: program.programId, lamports: 1, executable: false, rentEpoch: 0 }
}
