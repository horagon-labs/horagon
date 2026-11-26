import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(join(import.meta.dirname, '..', 'lib', file), 'utf8')
const burner = read('burner.ts')
const keyStore = read('key-store.ts')

const specifiers = (source: string) =>
  [...source.matchAll(/^(?:import|export)\s[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('burner.ts and key-store.ts stay off the network (R1, R5c)', () => {
  it('burner.ts imports only Keypair from web3.js, and the key store', () => {
    expect([...new Set(specifiers(burner))]).toEqual(['@solana/web3.js', './key-store'])
    expect(burner).toMatch(/^import \{ Keypair \} from '@solana\/web3\.js'$/m)
  })

  it('key-store.ts imports bs58 only: no web3.js on a page load', () => {
    expect(specifiers(keyStore)).toEqual(['bs58'])
  })

  for (const [name, source] of [
    ['burner.ts', burner],
    ['key-store.ts', keyStore],
  ] as const) {
    it(`${name} uses no network API and does not reach the client`, () => {
      // Comments may mention these words; the code may not.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const pattern of [
        /\bfetch\b/,
        /\bConnection\b/,
        /XMLHttpRequest/,
        /WebSocket/,
        /sendBeacon/,
        /\.\/api/,
        /@horagon\/sdk/,
      ]) {
        expect(code, String(pattern)).not.toMatch(pattern)
      }
    })
  }
})
