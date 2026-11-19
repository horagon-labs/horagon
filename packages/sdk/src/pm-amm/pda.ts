import { PublicKey } from '@solana/web3.js'
import { HoragonError } from '../errors'
import { PM_AMM_PROGRAM_ID } from './constants'

const utf8 = new TextEncoder()
const U64_MAX = 2n ** 64n - 1n

export function u64Le(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) {
    throw new HoragonError('INVALID_INPUT', `u64 out of range: ${value}`)
  }
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

function pda(seeds: Uint8Array[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

/** ["market", market_id u64 LE]. One namespace shared by every pm-AMM user. */
export function deriveMarketPda(marketId: bigint, programId = PM_AMM_PROGRAM_ID): PublicKey {
  return pda([utf8.encode('market'), u64Le(marketId)], programId)
}

export function deriveYesMint(market: PublicKey, programId = PM_AMM_PROGRAM_ID): PublicKey {
  return pda([utf8.encode('yes_mint'), market.toBytes()], programId)
}

export function deriveNoMint(market: PublicKey, programId = PM_AMM_PROGRAM_ID): PublicKey {
  return pda([utf8.encode('no_mint'), market.toBytes()], programId)
}

export function deriveVault(market: PublicKey, programId = PM_AMM_PROGRAM_ID): PublicKey {
  return pda([utf8.encode('vault'), market.toBytes()], programId)
}

export function deriveLpPosition(
  market: PublicKey,
  owner: PublicKey,
  programId = PM_AMM_PROGRAM_ID,
): PublicKey {
  return pda([utf8.encode('lp'), market.toBytes(), owner.toBytes()], programId)
}
