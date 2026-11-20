// Test-only Borsh encoder driven by the IDL's own type table: an oracle that shares no code
// with src/program/borsh.ts. Values use the IDL's snake_case field names.
import { PublicKey } from '@solana/web3.js'
import { Buffer } from 'buffer'

export type IdlType =
  | string
  | { array: [IdlType, number] }
  | { option: IdlType }
  | { defined: { name: string } }

interface IdlField {
  name: string
  type: IdlType
}

export interface IdlTypeDef {
  name: string
  type: { kind: 'struct'; fields: IdlField[] } | { kind: 'enum'; variants: Array<{ name: string }> }
}

export function encodeIdl(types: IdlTypeDef[], type: IdlType, value: unknown): Buffer {
  if (typeof type === 'string') {
    switch (type) {
      case 'u8':
        return Buffer.of(value as number)
      case 'bool':
        return Buffer.of(value ? 1 : 0)
      case 'u16': {
        const b = Buffer.alloc(2)
        b.writeUInt16LE(value as number)
        return b
      }
      case 'u32': {
        const b = Buffer.alloc(4)
        b.writeUInt32LE(value as number)
        return b
      }
      case 'u64': {
        const b = Buffer.alloc(8)
        b.writeBigUInt64LE(BigInt(value as bigint))
        return b
      }
      case 'i64': {
        const b = Buffer.alloc(8)
        b.writeBigInt64LE(BigInt(value as bigint))
        return b
      }
      case 'u128': {
        const v = BigInt(value as bigint)
        const b = Buffer.alloc(16)
        b.writeBigUInt64LE(v & (2n ** 64n - 1n), 0)
        b.writeBigUInt64LE(v >> 64n, 8)
        return b
      }
      case 'pubkey':
        return Buffer.from((value as PublicKey).toBytes())
      case 'string': {
        const s = Buffer.from(value as string, 'utf8')
        const len = Buffer.alloc(4)
        len.writeUInt32LE(s.length)
        return Buffer.concat([len, s])
      }
      default:
        throw new Error(`unsupported IDL type ${type}`)
    }
  }
  if ('array' in type) {
    const [inner, n] = type.array
    const items = value as unknown[]
    if (items.length !== n) throw new Error(`array needs ${n} items`)
    return Buffer.concat(items.map((v) => encodeIdl(types, inner, v)))
  }
  if ('option' in type) {
    return value === null || value === undefined
      ? Buffer.of(0)
      : Buffer.concat([Buffer.of(1), encodeIdl(types, type.option, value)])
  }
  const def = types.find((t) => t.name === type.defined.name)
  if (!def) throw new Error(`IDL has no type ${type.defined.name}`)
  if (def.type.kind === 'enum') {
    const index = def.type.variants.findIndex((v) => v.name === value)
    if (index < 0) throw new Error(`${def.name} has no variant ${String(value)}`)
    return Buffer.of(index)
  }
  const record = value as Record<string, unknown>
  return Buffer.concat(
    def.type.fields.map((f) => {
      if (!(f.name in record)) throw new Error(`${def.name}.${f.name} missing from the sample`)
      return encodeIdl(types, f.type, record[f.name])
    }),
  )
}

export const key = (n: number) =>
  new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 256))
