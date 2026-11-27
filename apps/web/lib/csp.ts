// The Content-Security-Policy of every page (R9, docs/security.md). The play wallet's key sits
// in localStorage (lib/burner.ts), so the policy's job is that no injected script runs and no
// page sends data to another host. proxy.ts draws a nonce per request and sends this policy;
// Next reads the nonce from it and puts it on its own scripts.

/**
 * The API the browser calls (lib/api.ts). Same-origin `/api/v1` unless NEXT_PUBLIC_API_BASE
 * names another; the policy's connect-src follows it, so the two cannot drift.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1'

/**
 * Where the browser may connect: this origin, plus the API's origin when the base is an
 * absolute http(s) URL. Nothing else in the browser opens a connection (no RPC: the API relays
 * every transaction). Any other scheme or a broken URL adds nothing.
 */
export function connectSources(apiBase: string): string[] {
  const sources = ["'self'"]
  if (!/^https?:\/\//i.test(apiBase)) return sources
  try {
    sources.push(new URL(apiBase).origin)
  } catch {
    // Not a URL: the API calls fail visibly rather than widen the policy.
  }
  return sources
}

export interface PolicyInput {
  /** Fresh per request (newNonce). */
  nonce: string
  /** `next dev`: React's dev overlay needs eval. */
  dev: boolean
  apiBase: string
}

export function contentSecurityPolicy({ nonce, dev, apiBase }: PolicyInput): string {
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    // 'strict-dynamic': the nonced Next runtime loads the page chunks (and web3.js on the first
    // wallet action); CSP3 browsers then ignore 'self', older ones fall back to it.
    [
      'script-src',
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    // React writes style="" attributes into the server HTML (motion's first frame, chart sizes),
    // and an attribute cannot carry a nonce. With img-src and font-src same-origin, an injected
    // style cannot send anything to another host.
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'"],
    ['font-src', "'self'"],
    ['connect-src', ...connectSources(apiBase)],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ]
  return directives.map((d) => d.join(' ')).join('; ')
}

/** 128 random bits, base64: a nonce nobody can guess, drawn per request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}
