#!/usr/bin/env node
// Prints who can upgrade the horagon program: it reads the program account and its ProgramData
// account over JSON-RPC and decodes the upgrade authority. Read-only: two getAccountInfo calls,
// no key, no transaction, no install or build. Node 22 or later. docs/runbook.md, procedure M.
//
//   node ops/check-upgrade-authority.mjs [--rpc <url>] [--program <id>] [--expect <pubkey>]
//
// Exit 0: read (and equal to --expect when given). 1: the authority is not --expect. 2: the
// accounts could not be read or are not an upgradeable program. Only the RPC's host is printed,
// never its path or query (a provider key can sit there). The pure parts are exported for
// apps/keeper/test/check-upgrade-authority.test.ts; ops/check-upgrade-authority.d.mts types them.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const HORAGON_PROGRAM_ID = 'HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF'
export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const DEFAULT_RPC = 'https://api.devnet.solana.com'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Encode(bytes) {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = `1${out}`
  }
  return out
}

/** UpgradeableLoaderState::Program: u32 tag 2, then the ProgramData address. */
export function decodeProgramAccount(data, owner) {
  if (owner !== BPF_UPGRADEABLE_LOADER) {
    throw new Error(`the program account is not owned by the upgradeable loader (owner ${owner})`)
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.length < 36 || view.getUint32(0, true) !== 2) {
    throw new Error('the program account is not an upgradeable Program account')
  }
  return base58Encode(data.subarray(4, 36))
}

/**
 * UpgradeableLoaderState::ProgramData: u32 tag 3, u64 slot of the last deploy, then
 * Option<Pubkey> (one byte, 1 = Some, then 32 bytes). No authority: it can never be upgraded.
 */
export function decodeProgramData(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.length < 13 || view.getUint32(0, true) !== 3) {
    throw new Error('not a ProgramData account')
  }
  const slot = view.getBigUint64(4, true)
  if (data[12] === 0) return { slot, authority: null }
  if (data[12] !== 1 || data.length < 45) throw new Error('not a ProgramData account')
  return { slot, authority: base58Encode(data.subarray(13, 45)) }
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return '(not a URL)'
  }
}

async function accountInfo(rpc, key, fetchImpl) {
  const res = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [key, { encoding: 'base64', commitment: 'confirmed' }],
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`the RPC answered HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`the RPC refused getAccountInfo (code ${body.error.code})`)
  const value = body.result?.value
  if (!value) return null
  return { owner: value.owner, data: new Uint8Array(Buffer.from(value.data[0], 'base64')) }
}

/** Reads and decodes; returns the lines to print and the exit code. Never throws. */
export async function checkUpgradeAuthority({
  rpc = DEFAULT_RPC,
  program = HORAGON_PROGRAM_ID,
  expect,
  fetchImpl = fetch,
}) {
  const lines = [`rpc host: ${hostOf(rpc)}`, `program: ${program}`]
  try {
    const prog = await accountInfo(rpc, program, fetchImpl)
    if (!prog) return { code: 2, lines: [...lines, `error: no account at ${program}`] }
    const programData = decodeProgramAccount(prog.data, prog.owner)
    lines.push(`program data: ${programData}`)
    const pd = await accountInfo(rpc, programData, fetchImpl)
    if (!pd) return { code: 2, lines: [...lines, `error: no account at ${programData}`] }
    if (pd.owner !== BPF_UPGRADEABLE_LOADER) {
      return { code: 2, lines: [...lines, 'error: the program data account has another owner'] }
    }
    const { slot, authority } = decodeProgramData(pd.data)
    lines.push(`last deploy slot: ${slot}`)
    lines.push(`upgrade authority: ${authority ?? 'none (the program can no longer be upgraded)'}`)
    if (expect !== undefined && authority !== expect) {
      lines.push(`MISMATCH: expected ${expect}`)
      return { code: 1, lines }
    }
    if (expect !== undefined) lines.push('matches --expect')
    return { code: 0, lines }
  } catch (e) {
    // The message names no URL: only the host is ever printed.
    const name = e instanceof Error ? e.name : 'Error'
    const message = e instanceof Error && !/https?:/i.test(e.message) ? e.message : 'read failed'
    return { code: 2, lines: [...lines, `error: ${name}: ${message}`] }
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const { values } = parseArgs({
    options: {
      rpc: { type: 'string' },
      program: { type: 'string' },
      expect: { type: 'string' },
    },
  })
  const r = await checkUpgradeAuthority({
    rpc: values.rpc ?? DEFAULT_RPC,
    program: values.program ?? HORAGON_PROGRAM_ID,
    expect: values.expect,
  })
  for (const line of r.lines) console.log(line)
  process.exitCode = r.code
}
