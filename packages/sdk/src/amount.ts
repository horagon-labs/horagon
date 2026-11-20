import { HoragonError } from './errors'

/** mUSDC and the YES/NO outcome tokens all use 6 decimals: 1 share pays 1 mUSDC. */
export const TOKEN_DECIMALS = 6
const SCALE = 10n ** BigInt(TOKEN_DECIMALS)
/** At most 1e12 whole units: far above any devnet balance, far below 2^53 raw. */
const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/

/** "12.5" (or 12.5) -> 12_500_000n raw units. Rejects negatives, exponents and > 6 decimals. */
export function parseAmount(value: string | number, field = 'amount'): bigint {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (typeof text !== 'string' || !DECIMAL.test(text)) {
    throw new HoragonError(
      'INVALID_INPUT',
      `${field} must be a decimal amount with at most 6 decimals, got ${String(value)}`,
    )
  }
  const [whole = '0', fraction = ''] = text.split('.')
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(TOKEN_DECIMALS, '0'))
}

/** 12_500_000n -> "12.5"; 0n -> "0". Negative values keep their sign. */
export function formatAmount(raw: bigint): string {
  const sign = raw < 0n ? '-' : ''
  const abs = raw < 0n ? -raw : raw
  const whole = abs / SCALE
  const fraction = (abs % SCALE).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '')
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`
}
