// Types of ops/check-upgrade-authority.mjs, so that apps/keeper/test typechecks under strict mode
// without allowJs. Keep it in step with the script.

export const HORAGON_PROGRAM_ID: string
export const BPF_UPGRADEABLE_LOADER: string
export const DEFAULT_RPC: string

export function base58Encode(bytes: Uint8Array): string
/** The ProgramData address of an upgradeable program account; throws on anything else. */
export function decodeProgramAccount(data: Uint8Array, owner: string): string
/** The last deploy slot and the upgrade authority (null: no longer upgradeable). */
export function decodeProgramData(data: Uint8Array): { slot: bigint; authority: string | null }

export interface CheckOptions {
  rpc?: string
  program?: string
  /** A pubkey the authority must equal (exit 1 otherwise). */
  expect?: string
  // biome-ignore lint/suspicious/noExplicitAny: a fetch-like function, tests pass their own
  fetchImpl?: (url: string, init: any) => Promise<Response>
}

export function checkUpgradeAuthority(
  opts: CheckOptions,
): Promise<{ code: 0 | 1 | 2; lines: string[] }>
