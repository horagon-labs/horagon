import type { SwapDirection } from './curve'

/** pm-AMM swap fee on the USDC leg (instructions/swap.rs SWAP_FEE_BPS), split 50/50 DAO/creator. */
export const SWAP_FEE_BPS = 200n

/** `amount * 200 / 10_000`, floored, exactly like the program. */
export function feeOf(amount: bigint): bigint {
  return (amount * SWAP_FEE_BPS) / 10_000n
}

export function isUsdcIn(direction: SwapDirection): boolean {
  return direction === 'usdcToYes' || direction === 'usdcToNo'
}

export function isUsdcOut(direction: SwapDirection): boolean {
  return direction === 'yesToUsdc' || direction === 'noToUsdc'
}
