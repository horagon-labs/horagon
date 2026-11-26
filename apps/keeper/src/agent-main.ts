// The reference agent process: systemd user unit `horagon-agent` on the VPS, installed by
// ops/deploy-keeper.sh, which never starts or restarts it: that is done by hand. It never runs
// inside the keeper process. Without AGENT_ENABLED=1 it logs "agent disabled" and exits 0, and
// it exits 0 as well when docs/metrics-wallets.json does not list its wallet as team-burner.
// SIGTERM ends the round in progress; a second signal exits at once.
import { errorSummary } from '@horagon/sdk'
import { runAgent } from './agent/run'

const stop = new AbortController()
let signals = 0
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signals++
    if (signals > 1) process.exit(130)
    stop.abort()
  })
}

runAgent(process.env, { signal: stop.signal }).then(
  (code) => process.exit(code),
  (err) => {
    // Start-up failures only (configuration, keypair, cluster refusal). The message is redacted:
    // a URL in it may carry an RPC key. The keypair and the database URL are never printed.
    console.error(`agent failed to start: ${errorSummary(err).message}`)
    process.exit(1)
  },
)
