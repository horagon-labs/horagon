// The reference agent process: systemd user unit `horagon-agent` on the VPS, installed by
// ops/deploy-keeper.sh, which never starts or restarts it: that is done by hand. It never runs
// inside the keeper process. Without AGENT_ENABLED=1 it logs "agent disabled" and exits 0, and
// it exits 0 as well when docs/metrics-wallets.json does not list its wallet as team-burner.
// SIGTERM ends the round in progress before its next send (a send in flight completes); a second
// signal exits at once. A failed start, or a loop that ends on an error, logs `agent failed to
// start: ...` (or `agent stopped on an error: ...`), pages `agent-down` and exits 1 (agentMain).
import { agentMain } from './agent/run'

const stop = new AbortController()
let signals = 0
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signals++
    if (signals > 1) process.exit(130)
    stop.abort()
  })
}

agentMain(process.env, { signal: stop.signal }).then(
  (code) => process.exit(code),
  // agentMain catches the agent's own errors; this is only for one in its own reporting.
  () => process.exit(1),
)
