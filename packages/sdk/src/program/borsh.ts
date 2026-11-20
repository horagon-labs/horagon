// Minimal Borsh for the `horagon` program's own layouts (little-endian integers, u32-length
// strings, 1-byte Option tag, 1-byte enum variant). Hand-written so the browser bundle needs
// no Anchor client; test/program/idl-contract.test.ts checks every layout against the IDL.
import { PublicKey } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { HoragonError } from '../errors'

const U64_MAX = 2n ** 64n - 1n
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n
const U128_MAX = 2n ** 128n - 1n
const utf8 = new TextEncoder()
const utf8Decode = new TextDecoder('utf-8', { fatal: true })

function range(field: string, value: bigint | number, min: bigint | number, max: bigint | number) {
  if (value < min || value > max) {
    throw new HoragonError('INVALID_INPUT', `${field} out of range: ${value}`)
  }
}

export class BorshWriter {
  private readonly parts: Uint8Array[] = []

  u8(value: number, field = 'u8'): this {
    if (!Number.isInteger(value))
      throw new HoragonError('INVALID_INPUT', `${field} is not an integer`)
    range(field, value, 0, 0xff)
    this.parts.push(Uint8Array.of(value))
    return this
  }

  u16(value: number, field = 'u16'): this {
    if (!Number.isInteger(value))
      throw new HoragonError('INVALID_INPUT', `${field} is not an integer`)
    range(field, value, 0, 0xffff)
    const b = Buffer.alloc(2)
    b.writeUInt16LE(value)
    this.parts.push(b)
    return this
  }

  u32(value: number, field = 'u32'): this {
    if (!Number.isInteger(value))
      throw new HoragonError('INVALID_INPUT', `${field} is not an integer`)
    range(field, value, 0, 0xffff_ffff)
    const b = Buffer.alloc(4)
    b.writeUInt32LE(value)
    this.parts.push(b)
    return this
  }

  u64(value: bigint, field = 'u64'): this {
    range(field, value, 0n, U64_MAX)
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(value)
    this.parts.push(b)
    return this
  }

  i64(value: bigint | number, field = 'i64'): this {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new HoragonError('INVALID_INPUT', `${field} is not a safe integer`)
    }
    const v = BigInt(value)
    range(field, v, I64_MIN, I64_MAX)
    const b = Buffer.alloc(8)
    b.writeBigInt64LE(v)
    this.parts.push(b)
    return this
  }

  bool(value: boolean): this {
    this.parts.push(Uint8Array.of(value ? 1 : 0))
    return this
  }

  pubkey(value: PublicKey): this {
    this.parts.push(value.toBytes())
    return this
  }

  fixed(value: Uint8Array, length: number, field = 'bytes'): this {
    if (value.length !== length) {
      throw new HoragonError(
        'INVALID_INPUT',
        `${field} must be ${length} bytes, got ${value.length}`,
      )
    }
    this.parts.push(value)
    return this
  }

  string(value: string, maxBytes: number, field = 'string'): this {
    const bytes = utf8.encode(value)
    if (bytes.length > maxBytes) {
      throw new HoragonError('INVALID_INPUT', `${field} is ${bytes.length} bytes, max ${maxBytes}`)
    }
    this.u32(bytes.length)
    this.parts.push(bytes)
    return this
  }

  option<T>(value: T | null | undefined, write: (w: this, v: T) => void): this {
    if (value === null || value === undefined) return this.u8(0)
    this.u8(1)
    write(this, value)
    return this
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts)
  }
}

export class BorshReader {
  private offset = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get position(): number {
    return this.offset
  }

  private take(length: number): number {
    const start = this.offset
    if (start + length > this.bytes.length) {
      throw new HoragonError('INVALID_INPUT', `account data too short at byte ${start}`)
    }
    this.offset += length
    return start
  }

  u8(): number {
    return this.view.getUint8(this.take(1))
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true)
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true)
  }

  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true)
  }

  i64(): bigint {
    return this.view.getBigInt64(this.take(8), true)
  }

  u128(): bigint {
    const lo = this.u64()
    const hi = this.u64()
    const v = (hi << 64n) | lo
    range('u128', v, 0n, U128_MAX)
    return v
  }

  bool(): boolean {
    const b = this.u8()
    if (b > 1) throw new HoragonError('INVALID_INPUT', `invalid bool byte ${b}`)
    return b === 1
  }

  pubkey(): PublicKey {
    const start = this.take(32)
    return new PublicKey(this.bytes.subarray(start, start + 32))
  }

  fixed(length: number): Uint8Array {
    const start = this.take(length)
    return this.bytes.slice(start, start + length)
  }

  string(): string {
    const length = this.u32()
    const start = this.take(length)
    return utf8Decode.decode(this.bytes.subarray(start, start + length))
  }

  option<T>(read: (r: this) => T): T | null {
    const tag = this.u8()
    if (tag === 0) return null
    if (tag !== 1) throw new HoragonError('INVALID_INPUT', `invalid Option tag ${tag}`)
    return read(this)
  }
}

/** Zero-padded ASCII in a fixed-size field (`league: [u8; 8]`, `home: [u8; 4]`). */
export function asciiField(value: string, length: number, field: string): Uint8Array {
  if (!/^[A-Z0-9]+$/.test(value) || value.length > length) {
    throw new HoragonError('INVALID_INPUT', `${field} must be 1-${length} chars of [A-Z0-9]`)
  }
  const out = new Uint8Array(length)
  out.set(utf8.encode(value))
  return out
}

export function readAsciiField(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return utf8Decode.decode(end === -1 ? bytes : bytes.subarray(0, end))
}
