import type { SessionEngine, Session } from "@/engine/session-engine"
import type { IUserBuliInteractionDriver } from "@/engine/interaction-driver"


import { BuliPromptsHandler } from "@/engine/prompts-handler"

type Listener = () => void
type Unsubscribe = () => void

// A store is an object or system that holds application data and lets
// other parts of the program read or react to changes in that data.
// Generic shape somthing react can observe
//
interface ViewSubscribe<Snapshot> {
  // tell me when Snapshot changes
  // subscribe(listener) register callback and return unsubscribe
  //
  // React gives us listener function
  // Store must call listener when its state changes
  // Then react knows "I should rerender"
  // Return value is another function: unsubscribe
  readonly subscribe: (listener: Listener) => Unsubscribe
  // get current state
  readonly getSnapshot: () => Snapshot
}


type BuliRoute = { type: "home" } | { type: "session", sessionId: string }


export interface IBuliApplicationSnapshot {
  sessions: Session[]
}

class BuliApplicationState {
  snapshot: IBuliApplicationSnapshot
  constructor() {
    this.snapshot = {
      sessions: []
    }
  }
  subscribe(listener: Listener): Unsubscribe {
    return () => { }
  }
  getSnapshot(): IBuliApplicationSnapshot { return this.snapshot }
}

export interface IBuliApplicationRuntime extends ViewSubscribe<IBuliApplicationSnapshot> {
  sessions: SessionEngine
}

interface IBuliRuntimeOptions {
  sessions: SessionEngine
}


type TPromptPartInput = { type: "text", text: string }
export interface ISessionPromptInput {
  sessionId: string
  parts?: TPromptPartInput[]
}


export interface ICreateSessionInput { }



export interface ISessionEngineOptions {
  driver: IUserBuliInteractionDriver
}






export class BuliApplicationRuntime implements IBuliApplicationRuntime {

  state: BuliApplicationState
  sessions: SessionEngine
  prompts: BuliPromptsHandler

  constructor(options: IBuliRuntimeOptions) {
    this.sessions = options.sessions
    this.state = new BuliApplicationState()
    this.prompts = new BuliPromptsHandler({
      sessions: {
        get: (sessionId: string) => this.sessions.get(sessionId),
        create: (session: ICreateSessionInput) => this.sessions.create(session),
        prompt: async () => undefined,
        updateSelectedModel: async () => undefined
      }
    })
  }

  readonly subscribe = (listener: Listener): Unsubscribe => {
    return this.state.subscribe(listener)
  }
  readonly getSnapshot = (): IBuliApplicationSnapshot => this.state.getSnapshot()
}


