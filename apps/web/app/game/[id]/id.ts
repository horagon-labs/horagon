/** A malformed escape (`%E0%A4`) stays as typed; the API then answers that no such game exists. */
export function decodedId(id: string): string {
  try {
    return decodeURIComponent(id)
  } catch {
    return id
  }
}
