// The Content-Security-Policy of every page (R9, docs/security.md). The play wallet's key sits
// in localStorage (lib/burner.ts), so the policy's job is that no injected script runs and no
// page sends data to another host. proxy.ts draws a nonce per request and sends this policy;
// Next reads the nonce from it and puts it on its own scripts. /verify/<market> is the one page
// that connects elsewhere (isVerifyPage).

/**
 * The API the browser calls (lib/api.ts). Same-origin `/api/v1` unless NEXT_PUBLIC_API_BASE
 * names another; the policy's connect-src follows it, so the two cannot drift.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1'

/**
 * Where the browser may connect: this origin, plus the API's origin when the base is an
 * absolute http(s) URL. Outside /verify nothing else in the browser opens a connection (no RPC:
 * the API relays every transaction). Any other scheme or a broken URL adds nothing.
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

/**
 * /verify/<market>: the page that checks a result without trusting Horagon. It reads the market
 * accounts from a Solana RPC the viewer picks and the evidence from the URI stored on chain, from
 * the browser (components/verify-view.tsx), so its connect-src adds `https:`. One path segment
 * after /verify/, as the route has; /verify itself, /verifyx and deeper paths are not it.
 */
export function isVerifyPage(pathname: string): boolean {
  return /^\/verify\/[^/]+\/?$/.test(pathname)
}

export interface PolicyInput {
  /** Fresh per request (newNonce). */
  nonce: string
  /** `next dev`: React's dev overlay needs eval. */
  dev: boolean
  apiBase: string
  /** The request's path: /verify pages connect to any https: host (isVerifyPage). */
  pathname: string
}

export function contentSecurityPolicy({ nonce, dev, apiBase, pathname }: PolicyInput): string {
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
    // /verify reaches the viewer's RPC and the evidence host; a page's policy is fixed when its
    // document loads, so links into /verify are plain <a> (docs/security.md).
    ['connect-src', ...connectSources(apiBase), ...(isVerifyPage(pathname) ? ['https:'] : [])],
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
