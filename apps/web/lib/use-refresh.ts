'use client'
// Asks the server to render the page again (router.refresh), in place: the server components run
// again and the client components keep their state. The first screen asks once its frame no
// longer fits (components/tonight-board.tsx, lib/chrono/board.ts frameStale). At most once per
// `key` for as long as the component stays mounted: a refresh that brings the same frame back
// keeps its key, so it never asks again, and no render loop can come of it.
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

export function useRefresh(due: boolean, key: string): void {
  const router = useRouter()
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (!due || asked.current.has(key)) return
    asked.current.add(key)
    router.refresh()
  }, [due, key, router])
}
