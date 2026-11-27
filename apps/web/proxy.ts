// Every page gets a Content-Security-Policy with a fresh nonce (lib/csp.ts). The policy goes on
// the request too: Next reads the nonce from it while rendering and puts it on its scripts.
// Pages render per request (the root layout waits for the connection), so no page is served
// from a build-time HTML file without the nonce.
import { type NextRequest, NextResponse } from 'next/server'
import { API_BASE, contentSecurityPolicy, newNonce } from './lib/csp'

const HEADER = 'Content-Security-Policy'

export function proxy(request: NextRequest): NextResponse {
  const policy = contentSecurityPolicy({
    nonce: newNonce(),
    dev: process.env.NODE_ENV === 'development',
    apiBase: API_BASE,
  })
  const headers = new Headers(request.headers)
  headers.set(HEADER, policy)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set(HEADER, policy)
  return response
}

export const config = {
  matcher: [
    {
      // Not the API (JSON), static chunks, images or the app's icon and manifest files.
      source:
        '/((?!api/|_next/static|_next/image|favicon\\.ico|icons/|icon\\.svg|apple-icon|manifest\\.webmanifest).*)',
      // A router prefetch carries no HTML, so it needs no nonce.
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
