'use client'
// The crown as a bottom sheet on mobile (spec 3.2), on the native <dialog> like AgeDialog.
// From 1024 px the game screen shows CrownPanel inline instead, and this sheet stays closed.
import { type ReactNode, useEffect, useRef } from 'react'

export function CrownSheet(p: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (p.open && !d.open) d.showModal()
    else if (!p.open && d.open) d.close()
  }, [p.open])

  return (
    <dialog
      ref={dialog}
      aria-label={p.title}
      onClose={p.onClose}
      className="mx-auto mt-auto mb-0 max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-face border border-b-0 border-brass-500/20 bg-enamel-900 p-4 text-ivory-100 backdrop:bg-black/70"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-15 font-semibold">{p.title}</h2>
        <button
          type="button"
          onClick={() => dialog.current?.close()}
          aria-label="Close"
          className="grid size-11 place-items-center"
        >
          ✕
        </button>
      </div>
      {p.children}
    </dialog>
  )
}
