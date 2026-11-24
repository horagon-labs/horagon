'use client'
// The 18+ self-declaration (spec section 12): one box, ticked before a burner is created or
// imported, and before the first send of a burner that was never asked. The answer stays on
// this device (lib/burner.ts); it is never sent, logged or put in a URL.
import { useEffect, useRef, useState } from 'react'

export function AgeCheckbox(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="space-y-2 text-13">
      <p>Horagon is play money on Solana devnet. No real value. No prizes.</p>
      <label className="flex min-h-11 items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
          className="size-5 accent-lume-300"
        />
        I am 18 or older
      </label>
    </div>
  )
}

/** Modal gate. `onConfirm` runs only with the box ticked; closing it any other way cancels. */
export function AgeDialog(props: {
  open: boolean
  error: string | undefined
  onConfirm: () => void
  onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [ticked, setTicked] = useState(false)

  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (props.open && !d.open) {
      setTicked(false)
      d.showModal()
    } else if (!props.open && d.open) {
      d.close()
    }
  }, [props.open])

  return (
    <dialog
      ref={dialog}
      aria-labelledby="age-gate-title"
      // Escape or "Not now" while the gate is still wanted: the pending action is dropped.
      onClose={() => props.open && props.onCancel()}
      className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-face border border-brass-500/20 bg-enamel-900 p-5 text-ivory-100 backdrop:bg-black/70"
    >
      <div className="space-y-4">
        <h2 id="age-gate-title" className="text-15 font-semibold tracking-wide text-brass-400">
          Before you play
        </h2>
        <AgeCheckbox checked={ticked} onChange={setTicked} />
        {props.error && (
          <p role="alert" className="text-13 text-red-400">
            {props.error}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className="min-h-11 flex-1 rounded-card border border-line py-2"
          >
            Not now
          </button>
          <button
            type="button"
            disabled={!ticked}
            onClick={() => ticked && props.onConfirm()}
            className="min-h-11 flex-1 rounded-card bg-lume-300 py-2 font-semibold text-enamel-950 disabled:opacity-50"
          >
            Continue
          </button>
        </div>
      </div>
    </dialog>
  )
}
