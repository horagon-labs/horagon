import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PM_AMM_IX_DISCRIMINATORS, pmAmmInstructionName } from '../../src/pm-amm/instructions'

const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

describe('PM_AMM_IX_DISCRIMINATORS', () => {
  const idl = JSON.parse(
    readFileSync(new URL('../../vendor/pm-amm/src/idl/pm_amm.json', import.meta.url), 'utf8'),
  ) as { instructions: Array<{ name: string; discriminator: number[] }> }

  it.each(Object.entries(PM_AMM_IX_DISCRIMINATORS))(
    '%s matches the IDL and sha256',
    (name, disc) => {
      const fromIdl = idl.instructions.find((i) => i.name === snake(name))
      expect(fromIdl?.discriminator).toEqual(disc)
      const digest = createHash('sha256')
        .update(`global:${snake(name)}`)
        .digest()
      expect([...digest.subarray(0, 8)]).toEqual(disc)
    },
  )
})

describe('pmAmmInstructionName', () => {
  it('recognizes a swap and rejects unknown or short data', () => {
    const swap = Uint8Array.from([...PM_AMM_IX_DISCRIMINATORS.swap, 0, 1, 2])
    expect(pmAmmInstructionName(swap)).toBe('swap')
    expect(pmAmmInstructionName(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined()
    expect(pmAmmInstructionName(Uint8Array.from([248, 198]))).toBeUndefined()
  })
})
