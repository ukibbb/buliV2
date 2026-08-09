import { SessionEngine } from "@/engine/session-engine"
import type { ISessionSnapshot } from "@/domain"
import { OpenAiUserBuliInteractionDriver } from "@/providers/openai"
import { SessionView } from "@/runtime/session-view"

// A store is an object or system that holds application data and lets
// other parts of the program read or react to changes in that data.
// Generic shape somthing react can observe
//
export interface ISnapshotSource<Snapshot> {
  // tell me when Snapshot changes
  // subscribe(listener) register callback and return unsubscribe
  //
  // React gives us listener function
  // Store must call listener when its state changes
  // Then react knows "I should rerender"
  // Return value is another function: unsubscribe
  readonly subscribe: (listener: () => void) => () => void
  // get current state
  readonly getSnapshot: () => Snapshot
}

export interface IBuliPromptInput {
  sessionId: string
  text: string
}

/** The narrow application boundary available to React components. */
export interface IBuliApplicationClient {
  readonly submitPrompt: (prompt: IBuliPromptInput) => Promise<void>
  readonly view: (sessionId: string) => ISnapshotSource<ISessionSnapshot>
}

/** The bootstrap owner also receives disposal; UI components do not need it. */
export interface IBuliApplicationRuntime extends IBuliApplicationClient {
  readonly dispose: () => void
}

interface IBuliRuntimeOptions {
  sessions: SessionEngine
}

/** Connects the session services used by the UI. */
export class BuliApplicationRuntime implements IBuliApplicationRuntime {
  private readonly sessions: SessionEngine
  /** Creates and reuses one UI view for each session. */
  private readonly views = new Map<string, SessionView>()
  private disposed = false

  constructor(options: IBuliRuntimeOptions) {
    this.sessions = options.sessions
  }

  /** Converts text entered in the UI into a session prompt. */
  readonly submitPrompt = async (prompt: IBuliPromptInput): Promise<void> => {
    await this.sessions.prompt({
      sessionId: prompt.sessionId,
      parts: [{ type: "text", text: prompt.text }],
    })
  }

  readonly view = (sessionId: string): ISnapshotSource<ISessionSnapshot> => {
    if (this.disposed) throw new Error("Application runtime is disposed")

    // One cached source per session keeps React subscriptions stable across renders.
    const existing = this.views.get(sessionId)
    if (existing) return existing

    const view = new SessionView(sessionId, this.sessions.store)
    this.views.set(sessionId, view)
    return view
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true

    for (const view of this.views.values()) view.dispose()
    this.views.clear()
  }
}

interface IBuliApplicationOptions {
  signal: AbortSignal
}

/** Composes provider, engine, store, and application runtime in one place. */
export async function createBuliApplication(
  options: IBuliApplicationOptions,
): Promise<IBuliApplicationRuntime> {
  options.signal.throwIfAborted()

  const runtime = new BuliApplicationRuntime({
    sessions: new SessionEngine({
      driver: new OpenAiUserBuliInteractionDriver(),
    }),
  })

  options.signal.addEventListener("abort", runtime.dispose, { once: true })
  return runtime
}
