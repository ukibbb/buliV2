import type { SessionEngine } from "@/engine/session-engine"
import type { ViewSubscribe, IBuliApplicationSnapshot, Listener, Unsubscribe } from "@/application-snapshot"

import { BuliPromptsHandler } from "@/engine/prompts-handler"
import { BuliApplicationState } from "@/application-snapshot"
import type { ISessionSnapshot } from "@/engine/session-view-store"

// type BuliRoute = { type: "home" } | { type: "session", sessionId: string }


export interface IBuliPromptInput {
  sessionId: string
  text: string
}

export interface IBuliRuntimeOptions {
  sessions: SessionEngine
}

export interface IBuliApplicationRuntime extends ViewSubscribe<IBuliApplicationSnapshot> {
  sessions: SessionEngine
  submitPrompt: (prompt: IBuliPromptInput) => Promise<void>
  view: (sessionId: string) => ViewSubscribe<ISessionSnapshot>
}

export class BuliApplicationRuntime implements IBuliApplicationRuntime {
  readonly state: BuliApplicationState
  readonly sessions: SessionEngine
  readonly prompts: BuliPromptsHandler

  constructor(options: IBuliRuntimeOptions) {
    this.sessions = options.sessions
    this.state = new BuliApplicationState()
    this.prompts = new BuliPromptsHandler({
      sessions: this.sessions,
    })
  }

  submitPrompt(prompt: IBuliPromptInput): Promise<void> {
    console.log("BuliApplicationRuntime:submitPrompt")
    return this.prompts.submitPrompt(prompt)
  }

  subscribe(listener: Listener): Unsubscribe {
    return this.state.subscribe(listener)
  }

  getSnapshot(): IBuliApplicationSnapshot {
    return this.state.getSnapshot()
  }

  view(sessionId: string): ViewSubscribe<ISessionSnapshot> {
    return this.sessions.view(sessionId)
  }
}
