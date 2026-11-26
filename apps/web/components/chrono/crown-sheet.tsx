'use client'
// The crown as a bottom sheet on mobile (spec 3.2), on the native <dialog> like AgeDialog.
// From 1024 px the game screen shows CrownPanel inline instead, and this sheet stays closed.
// The sheet sits in the top layer over the play-money banner, so it carries the same line in a
// footer that stays put while its content scrolls (spec 2.7). Its title and Close stay at the
// top of the scrolling area, each open starts at the top, and a tap on the backdrop closes it.
import { PLAY_MONEY_NOTICE } from '@horagon/sdk/notice'
import { type MouseEvent, type ReactNode, useEffect, useRef } from 'react'

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * A press on the backdrop: its events reach the <dialog> itself, and they land outside the
 * sheet's box (a press on the sheet's own border hits the <dialog> too, but inside the box).
 */
export function backdropHit(
  target: unknown,
  sheet: unknown,
  at: { x: number; y: number },
  box: Box,
): boolean {
  if (target !== sheet) return false
  return at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom
}

const onBackdrop = (e: MouseEvent<HTMLDialogElement>) =>
  backdropHit(
    e.target,
    e.currentTarget,
    { x: e.clientX, y: e.clientY },
    e.currentTarget.getBoundingClientRect(),
  )

export function CrownSheet(p: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLDivElement>(null)
  // Only a press that also started on the backdrop closes: a bezel drag let go outside does not.
  const pressedBackdrop = useRef(false)
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (p.open && !d.open) {
      d.showModal()
      if (body.current) body.current.scrollTop = 0
    } else if (!p.open && d.open) d.close()
  }, [p.open])

  return (
    // Escape and Close stay the keyboard's way out; the backdrop tap is a pointer extra.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the native dialog closes on Escape itself.
    <dialog
      ref={dialog}
      aria-label={p.title}
      onClose={p.onClose}
      onPointerDown={(e) => {
        pressedBackdrop.current = onBackdrop(e)
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && onBackdrop(e)) e.currentTarget.close()
        pressedBackdrop.current = false
      }}
      className="mx-auto mt-auto mb-0 max-h-[92dvh] w-full max-w-lg overflow-hidden rounded-t-face border border-b-0 border-brass-500/20 bg-enamel-900 p-0 text-ivory-100 backdrop:bg-black/70"
    >
      <div className="flex max-h-[92dvh] flex-col">
        <div ref={body} className="overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center justify-between bg-enamel-900 px-4 pt-4 pb-2">
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
          <div className="px-4 pb-4">{p.children}</div>
        </div>
        <p
          role="note"
          className="shrink-0 border-t border-amber-400/40 px-4 py-2 text-center text-12 text-amber-400"
        >
          {PLAY_MONEY_NOTICE}
        </p>
      </div>
    </dialog>
  )
}
