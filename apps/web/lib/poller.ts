// The logic behind usePoll, free of React so it runs in Node tests. Each run gets a sequence
// number; only the newest run may report, so a slow older answer never overwrites a newer one.
export interface PollSink<T> {
  data: (value: T) => void
  error: (err: Error) => void
}

export function createPoller<T>(load: () => Promise<T>, sink: PollSink<T>) {
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
    /** A timer tick: skipped while a run is still in flight. */
    tick: (): Promise<void> => (inflight ? Promise.resolve() : run()),
    /** The key changed or the view closed: every run in flight is dropped. */
    reset: (): void => {
      latest++
      inflight = false
    },
  }
}
