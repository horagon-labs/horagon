// What a failing poll looks like (spec 4.4): stale at the first failure, kept data on screen,
// and the error text only after three failures in a row.
export const ERROR_AFTER = 3

export interface Health {
  /** Draw the thin red line and "Reconnecting…". */
  stale: boolean
  /** Hand this to ErrorText; undefined until the third failure in a row. */
  error: Error | undefined
}

export const pollHealth = (p: { error: Error | undefined; failures: number }): Health => ({
  stale: p.failures > 0,
  error: p.failures >= ERROR_AFTER ? p.error : undefined,
})
