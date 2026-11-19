import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'

/** Spike keypairs live in `<repo>/.keys/<name>.json` (git-ignored, Solana CLI format). */
export const KEYS_DIR = join(import.meta.dirname, '../../../.keys')

export function keypairPath(name: string): string {
  return join(KEYS_DIR, `${name}.json`)
}

export function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[]
  return Keypair.fromSecretKey(Uint8Array.from(bytes))
}

/** Load `.keys/<name>.json`, creating it on first use. Devnet and localnet only. */
export function loadOrCreateKeypair(name: string): Keypair {
  const path = keypairPath(name)
  if (existsSync(path)) return loadKeypair(path)
  const keypair = Keypair.generate()
  mkdirSync(KEYS_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 })
  console.log(`created ${path} (${keypair.publicKey.toBase58()})`)
  return keypair
}
