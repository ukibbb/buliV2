import { realpath } from "node:fs/promises"
import { SessionEngine } from "@/engine/session-engine"
import type { ISessionSnapshot } from "@/domain"
import {
  defaultSessionFilePath,
  JsonlSessionStore,
} from "@/engine/jsonl-session-store"
import type { ISessionStore } from "@/engine/session-store"
import { OpenAiUserBuliInteractionDriver } from "@/providers/openai/openai-turn-driver"
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
export interface IBuliApplication {
  readonly workspaceRoot: string
  readonly submitPrompt: (prompt: IBuliPromptInput) => Promise<void>
  readonly abort: (sessionId: string) => void
  readonly view: (sessionId: string) => ISnapshotSource<ISessionSnapshot>
}

interface IBuliRuntimeOptions {
  sessions: SessionEngine
  workspaceRoot: string
}

/** Connects the session services used by the UI. */
export class BuliApplicationRuntime implements IBuliApplication {
  readonly workspaceRoot: string
  private readonly sessions: SessionEngine
  /** Creates and reuses one UI view for each session. */
  private readonly views = new Map<string, SessionView>()
  private disposed = false

  constructor(options: IBuliRuntimeOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.sessions = options.sessions
  }

  /** Converts text entered in the UI into a session prompt. */
  readonly submitPrompt = async (prompt: IBuliPromptInput): Promise<void> => {
    if (prompt.text.trim() === "/reset") {
      this.sessions.reset()
      return
    }
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

  readonly abort = (sessionId: string): void => {
    if (this.disposed) throw new Error("Buli runtime is disposed")
    this.sessions.abort(sessionId)
  }
}

interface IBuliApplicationOptions {
  signal: AbortSignal
  store?: ISessionStore
}

/** Composes provider, engine, store, and application runtime in one place. */
export async function createBuliApplication(
  options: IBuliApplicationOptions,
): Promise<BuliApplicationRuntime> {
  options.signal.throwIfAborted()
  const workspaceRoot = await realpath(process.cwd())
  options.signal.throwIfAborted()


  // In future InteractionDriver based on provider
  // provider based on active auth setup?




  const store = options.store ?? new JsonlSessionStore({
    filePath: defaultSessionFilePath(workspaceRoot),
  })
  const runtime = new BuliApplicationRuntime({
    workspaceRoot,
    sessions: new SessionEngine({
      driver: new OpenAiUserBuliInteractionDriver({ workspaceRoot }),
      store,
    }),
  })

  options.signal.addEventListener("abort", runtime.dispose, { once: true })
  return runtime
}
