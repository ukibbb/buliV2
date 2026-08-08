import type { Session } from "@/engine/session-engine"

export type Listener = () => void
export type Unsubscribe = () => void

// A store is an object or system that holds application data and lets
// other parts of the program read or react to changes in that data.
// Generic shape somthing react can observe
//
export interface ViewSubscribe<Snapshot> {
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

export interface IBuliApplicationSnapshot {
  sessions: Session[]
}

export class BuliApplicationState {
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
