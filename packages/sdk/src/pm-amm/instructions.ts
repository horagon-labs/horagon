/** Anchor discriminators (sha256("global:<name>")[0..8]) of the pm-AMM instructions Horagon uses. */
export const PM_AMM_IX_DISCRIMINATORS = {
  initializeMarket: [35, 35, 189, 193, 155, 48, 170, 203],
  depositLiquidity: [245, 99, 59, 25, 151, 71, 233, 249],
  swap: [248, 198, 158, 145, 225, 117, 135, 200],
  withdrawLiquidity: [149, 158, 33, 185, 47, 243, 253, 31],
  redeemPair: [157, 102, 125, 192, 31, 48, 165, 114],
  resolveMarket: [155, 23, 80, 173, 46, 74, 23, 239],
  claimWinnings: [161, 215, 24, 59, 14, 236, 242, 221],
  claimLpResiduals: [245, 137, 197, 230, 204, 93, 183, 28],
} as const

export type PmAmmInstructionName = keyof typeof PM_AMM_IX_DISCRIMINATORS

const ENTRIES = Object.entries(PM_AMM_IX_DISCRIMINATORS) as Array<
  [PmAmmInstructionName, readonly number[]]
>

/** Which pm-AMM instruction this data encodes, or undefined. */
export function pmAmmInstructionName(data: Uint8Array): PmAmmInstructionName | undefined {
  if (data.length < 8) return undefined
  for (const [name, disc] of ENTRIES) {
    if (disc.every((b, i) => data[i] === b)) return name
  }
  return undefined
}
