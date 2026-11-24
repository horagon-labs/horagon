// The wordmark (spec 2.7): "HORAGON" in brass, spaced wide, after an hourglass.
export function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-brass-500">
      <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4">
        <path
          d="M4 2h8L8 8Z M4 14h8L8 8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-15 font-semibold tracking-[0.35em]">HORAGON</span>
    </span>
  )
}
