// One run at a time: a second start while the first is in flight does nothing. Used for
// Claim all, whose button shows in more than one place.
export function singleFlight() {
  let running = false
  return {
    running: (): boolean => running,
    /** Runs `task` unless a run is in flight; true when this call ran it. Errors pass through. */
    async run(task: () => Promise<void>): Promise<boolean> {
      if (running) return false
      running = true
      try {
        await task()
      } finally {
        running = false
      }
      return true
    },
  }
}
