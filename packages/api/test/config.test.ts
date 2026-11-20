import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import { parseSecretKey } from '../src/config'

describe('parseSecretKey', () => {
  it('reads a JSON byte array or base58, ignoring surrounding whitespace', () => {
    const kp = Keypair.generate()
    expect(parseSecretKey(JSON.stringify([...kp.secretKey])).publicKey).toEqual(kp.publicKey)
    expect(parseSecretKey(` ${bs58.encode(kp.secretKey)}\n`).publicKey).toEqual(kp.publicKey)
  })

  it('never quotes the value it was given when it cannot parse it', () => {
    // A trailing comma: JSON.parse's own message would quote the bytes around it.
    const malformed = `[${[...Keypair.generate().secretKey].join(',')},]`
    let err: unknown
    try {
      parseSecretKey(malformed)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(
      'Not a valid secret key: expected base58 or a JSON array of 64 bytes',
    )
    expect((err as Error).cause).toBeUndefined()
  })
})
