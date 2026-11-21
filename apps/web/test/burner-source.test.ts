import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'burner.ts'), 'utf8')

describe('burner.ts stays off the network (R1)', () => {
  it('imports only Keypair from web3.js and bs58', () => {
    const specifiers = [...source.matchAll(/^import\s[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(
      (m) => m[1],
    )
    expect(specifiers).toEqual(['@solana/web3.js', 'bs58'])
    expect(source).toMatch(/^import \{ Keypair \} from '@solana\/web3\.js'$/m)
  })

  it('uses no network API and does not reach the client', () => {
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
})
