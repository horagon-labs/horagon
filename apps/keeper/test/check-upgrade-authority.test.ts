import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  BPF_UPGRADEABLE_LOADER,
  checkUpgradeAuthority,
  decodeProgramAccount,
  decodeProgramData,
  HORAGON_PROGRAM_ID,
} from '../../../ops/check-upgrade-authority.mjs'

const programData = Keypair.generate().publicKey
const authority = Keypair.generate().publicKey

function programBytes(): Uint8Array {
  const b = new Uint8Array(36)
  new DataView(b.buffer).setUint32(0, 2, true)
  b.set(programData.toBytes(), 4)
  return b
}

function programDataBytes(auth: Uint8Array | null, slot = 431_000_123n): Uint8Array {
  const b = new Uint8Array(45 + 16)
  const v = new DataView(b.buffer)
  v.setUint32(0, 3, true)
  v.setBigUint64(4, slot, true)
  if (auth) {
    b[12] = 1
    b.set(auth, 13)
  }
  return b
}

/** A JSON-RPC endpoint with two accounts; records the methods called. */
function fakeRpc(accounts: Record<string, { owner: string; data: Uint8Array } | null>) {
  const calls: string[] = []
  const fetchImpl = async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { method: string; params: [string, unknown] }
    calls.push(req.method)
    const acc = accounts[req.params[0]] ?? null
    const value = acc && {
      owner: acc.owner,
      lamports: 1,
      executable: false,
      data: [Buffer.from(acc.data).toString('base64'), 'base64'],
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }))
  }
  return { calls, fetchImpl }
}

describe('decodeProgramAccount and decodeProgramData', () => {
  it('reads the ProgramData address, the last deploy slot and the authority', () => {
    expect(decodeProgramAccount(programBytes(), BPF_UPGRADEABLE_LOADER)).toBe(
      programData.toBase58(),
    )
    expect(decodeProgramData(programDataBytes(authority.toBytes()))).toEqual({
      slot: 431_000_123n,
      authority: authority.toBase58(),
    })
    // No authority: the program can never be upgraded again.
    expect(decodeProgramData(programDataBytes(null)).authority).toBeNull()
  })

  it('refuses an account that is not an upgradeable program', () => {
    expect(() =>
      decodeProgramAccount(programBytes(), Keypair.generate().publicKey.toBase58()),
    ).toThrow(/not owned by the upgradeable loader/)
    expect(() => decodeProgramData(programBytes())).toThrow(/not a ProgramData account/)
  })
})

describe('checkUpgradeAuthority', () => {
  const accounts = {
    [HORAGON_PROGRAM_ID]: { owner: BPF_UPGRADEABLE_LOADER, data: programBytes() },
    [programData.toBase58()]: {
      owner: BPF_UPGRADEABLE_LOADER,
      data: programDataBytes(authority.toBytes()),
    },
  }

  it('prints the current authority with reads only, and the RPC host without its path', async () => {
    const { calls, fetchImpl } = fakeRpc(accounts)
    const r = await checkUpgradeAuthority({
      rpc: 'https://rpc.example.com/v2/SECRETKEY?api-key=SECRETKEY',
      fetchImpl,
    })
    expect(calls).toEqual(['getAccountInfo', 'getAccountInfo'])
    expect(r.code).toBe(0)
    const text = r.lines.join('\n')
    expect(text).toContain(`upgrade authority: ${authority.toBase58()}`)
    expect(text).toContain(`program data: ${programData.toBase58()}`)
    expect(text).toContain('rpc.example.com')
    expect(text).not.toContain('SECRETKEY')
  })

  it('exits 1 when --expect names another key, and 0 when it matches', async () => {
    const { fetchImpl } = fakeRpc(accounts)
    const cold = Keypair.generate().publicKey.toBase58()
    const miss = await checkUpgradeAuthority({ rpc: 'https://r.test', expect: cold, fetchImpl })
    expect(miss.code).toBe(1)
    expect(miss.lines.join('\n')).toContain(`expected ${cold}`)
    const hit = await checkUpgradeAuthority({
      rpc: 'https://r.test',
      expect: authority.toBase58(),
      fetchImpl,
    })
    expect(hit.code).toBe(0)
  })

  it('exits 2 when the program account is missing', async () => {
    const { fetchImpl } = fakeRpc({})
    const r = await checkUpgradeAuthority({ rpc: 'https://r.test', fetchImpl })
    expect(r.code).toBe(2)
    expect(r.lines.join('\n')).toMatch(/no account/)
  })
})
