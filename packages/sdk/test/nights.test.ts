import { describe, expect, it } from 'vitest'
import { WINDOW } from '../../../scripts/count-fans.mjs'
import { FIRST_COUNTED_NIGHT, NIGHTS_TARGET } from '../src/nights'

describe('the nights My Game-day counts (R7)', () => {
  it('start on the first night of the frozen counter, never on a copied date', () => {
    // If this fails the constant is wrong: the script and docs/metrics.md are pre-registered.
    expect(FIRST_COUNTED_NIGHT).toBe(WINDOW.first)
  })

  it('aim at three nights', () => {
    expect(NIGHTS_TARGET).toBe(3)
  })
})
