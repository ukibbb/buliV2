import type { ISessionSnapshot } from "@/domain"
import type { ISessionStore } from "@/engine/session-store"

type Listener = () => void
type Unsubscribe = () => void

/** Keeps the UI snapshot for one session synchronized with the session store. */
export class SessionView {
  private snapshot: ISessionSnapshot
  private readonly subscriptions = new Set<Unsubscribe>()
  private disposed = false

  constructor(
    private readonly sessionId: string,
    private readonly store: ISessionStore,
  ) {
    this.snapshot = store.getSnapshot(sessionId)
  }

  readonly getSnapshot = (): ISessionSnapshot => {
    if (!this.disposed) this.snapshot = this.store.getSnapshot(this.sessionId)
    return this.snapshot
  }

  readonly subscribe = (listener: Listener): Unsubscribe => {
    if (this.disposed) throw new Error("Session view is disposed")

    const unsubscribeStore = this.store.subscribe(this.sessionId, () => {
      // The store replaces the snapshot before notifying, as required by React.
      this.snapshot = this.store.getSnapshot(this.sessionId)
      listener()
    })
    let active = true

    const unsubscribe = (): void => {
      if (!active) return
      active = false
      this.subscriptions.delete(unsubscribe)
      unsubscribeStore()
    }

    this.subscriptions.add(unsubscribe)
    return unsubscribe
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const unsubscribe of [...this.subscriptions]) unsubscribe()
  }
}
