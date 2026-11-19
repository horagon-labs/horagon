import { PublicKey } from '@solana/web3.js'

/** pm-AMM program, same address on devnet and mainnet. */
export const PM_AMM_PROGRAM_ID = new PublicKey('GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y')
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
/** Receives 50% of every swap fee (instructions/swap.rs PROTOCOL_DAO). */
export const PROTOCOL_DAO = new PublicKey('4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph')
/** Devnet collateral, mUSDC. */
export const DEVNET_MUSDC_MINT = new PublicKey('3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ')
export const MUSDC_DECIMALS = 6
/** sparkfun-labs/pm-amm commit the math port and the vendored SDK follow. */
export const PM_AMM_SOURCE_SHA = 'd5b407b6dbb83272e7dcd5b767270d5fd64786f1'
