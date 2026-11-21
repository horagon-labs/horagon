// The logic behind usePoll, free of React so it runs in Node tests. Each run gets a sequence
// number; only the newest run may report, so a slow older answer never overwrites a newer one.
export interface PollSink<T> {
  data: (value: T) => void
  error: (err: Error) => void
}

/**
 * `enabled` says whether there is anything to load (usePoll: a non-null key). While it is
 * false, `tick` and `refresh` do nothing; `run` is for the caller that already checked.
 */
export function createPoller<T>(
  load: () => Promise<T>,
  sink: PollSink<T>,
  enabled: () => boolean = () => true,
) {
  let latest = 0
  let inflight = false

  async function run(): Promise<void> {
    const seq = ++latest
    inflight = true
    try {
      const value = await load()
      if (seq === latest) sink.data(value)
    } catch (err) {
      if (seq === latest) sink.error(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (seq === latest) inflight = false
    }
  }

  return {
    /** Starts a run now; an older run still in flight is dropped. */
    run,
    /** A timer tick: skipped while a run is still in flight or there is nothing to load. */
    tick: (): Promise<void> => (inflight || !enabled() ? Promise.resolve() : run()),
    /** A reload the UI asked for (after a trade): like `run`, but nothing without a key. */
    refresh: (): Promise<void> => (enabled() ? run() : Promise.resolve()),
    /** The key changed or the view closed: every run in flight is dropped. */
    reset: (): void => {
      latest++
      inflight = false
    },
  }
}
