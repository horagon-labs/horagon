// The game page's Share button (R5): the system share sheet where there is one (Web Share API),
// else the link goes to the clipboard, else the page shows the link to copy by hand.

export interface ShareData {
  title: string
  text: string
  url: string
}

export interface ShareEnv {
  share?: (data: ShareData) => Promise<void>
  writeText?: (text: string) => Promise<void>
}

/** shared: the sheet took it; copied: the link is on the clipboard; cancelled: closed the sheet. */
export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed'

const isAbort = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError'

export async function shareAction(env: ShareEnv, data: ShareData): Promise<ShareResult> {
  if (env.share) {
    try {
      await env.share(data)
      return 'shared'
    } catch (err) {
      // Closing the sheet is a choice, not a failure; anything else falls back to the copy.
      if (isAbort(err)) return 'cancelled'
    }
  }
  if (env.writeText) {
    try {
      await env.writeText(data.url)
      return 'copied'
    } catch {
      // No clipboard permission: the link is shown instead.
    }
  }
  return 'failed'
}

/** The browser's share and clipboard, where this page may use them. */
export function shareEnv(nav: Navigator | undefined): ShareEnv {
  if (!nav) return {}
  const env: ShareEnv = {}
  if (typeof nav.share === 'function') env.share = (d) => nav.share(d)
  if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    env.writeText = (t) => nav.clipboard.writeText(t)
  }
  return env
}

/** The button's words after a try. */
export function shareLabel(result: ShareResult | null): string {
  return result === 'copied' ? 'Link copied' : 'Share'
}
