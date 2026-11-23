const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58 text to bytes: a transaction response gives inner instruction data in base58. */
export function base58Decode(text: string): Uint8Array {
  const bytes: number[] = []
  for (const ch of text) {
    let carry = B58.indexOf(ch)
    if (carry < 0) throw new Error('bad base58')
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of text) {
    if (ch !== '1') break
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}
