// WalletProvider itself, without a DOM environment (none is in the lockfile): its first render
// (the server's, and the browser's before effects) and the one effect it runs on mount. The rules
// that effect and the callbacks run are tested in wallet-core.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useWallet, WalletProvider } from '../components/wallet'

function Probe() {
  const w = useWallet()
  return (
    <p data-loaded={String(w.loaded)} data-age={String(w.ageNeeded)}>
      {w.address ?? 'no wallet'}
    </p>
  )
}

const source = readFileSync(join(import.meta.dirname, '..', 'components', 'wallet.tsx'), 'utf8')

describe('WalletProvider (R5)', () => {
  it('first renders not loaded, with no wallet and no 18+ dialog', () => {
    const html = renderToStaticMarkup(
      <WalletProvider>
        <Probe />
      </WalletProvider>,
    )
    expect(html).toBe('<p data-loaded="false" data-age="true">no wallet</p>')
    expect(html).not.toContain('18 or older')
  })

  it('runs one effect on mount: the core’s read-only mount and the storage listener', () => {
    const effects = [...source.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[([^\]]*)\]\)/g)]
    expect(effects).toHaveLength(1)
    const [, body, deps] = effects[0] ?? []
    expect(deps).toBe('core')
    expect(body).toContain('core.mount(() => window.localStorage)')
    // Nothing on the mount path opens the dialog or asks.
    for (const asks of ['openGate', 'setGateOpen', 'core.ask', 'core.withAge', 'core.confirm']) {
      expect(body, asks).not.toContain(asks)
    }
  })
})
