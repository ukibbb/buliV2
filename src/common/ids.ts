/** Generates an opaque identifier for runtime-owned entities. */
export function generateRandomId(): string {
  return crypto.randomUUID()
}
