// A timeout on every RPC call. The same pattern as the keeper's `timeoutFetch`
// (apps/keeper/src/config.ts); @horagon/sdk ships built, so it is not shared through it.
export const RPC_TIMEOUT_MS = 15_000

/** The abort signal covers the request and the reading of its body. */
export function timeoutFetch(ms: number, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return base(input, { ...init, signal })
  }
}
