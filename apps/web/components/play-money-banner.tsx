// Always on screen (spec section 2, legal): fixed to the bottom of every page.
export function PlayMoneyBanner() {
  return (
    <div
      role="note"
      className="fixed inset-x-0 bottom-0 z-20 bg-amber-300 px-4 py-2 text-center text-sm font-semibold text-amber-950"
    >
      Play-money on devnet. No real value. No prizes.
    </div>
  )
}
