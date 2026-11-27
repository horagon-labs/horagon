// Runs in the browser before the app's own modules. zod probes `Function('')` when the SDK builds
// its object schemas, to compile faster parsers; the page's CSP has no 'unsafe-eval' (lib/csp.ts),
// so the probe would only log a violation on every page load. Turn the probe off first.
import { config } from 'zod/v4/core'

config({ jitless: true })
