import { canonicalize } from './canonicalize'

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 via WebCrypto, available in browsers, Node 22+ and Deno. */
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
}

/** sha256(JCS(value)) as 32 bytes: the `evidence_hash` stored on chain. */
export async function evidenceHashBytes(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(new TextEncoder().encode(canonicalize(value)))
}

/** sha256(JCS(value)) as lowercase hex: the form shown on /verify and in the API. */
export async function evidenceHash(value: unknown): Promise<string> {
  return toHex(await evidenceHashBytes(value))
}
