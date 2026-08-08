import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react"


import type { IBuliApplicationSnapshot, ViewSubscribe } from "@/application-snapshot"

import { OpenAiUserBuliInteractionDriver } from "@/providers/openai"
import {
  BuliApplicationRuntime,
  type IBuliApplicationRuntime,
} from "@/runtime"

import { SessionEngine } from "@/engine/session-engine"
import type { ISessionSnapshot } from "@/engine/session-view-store"


export const BuliApplicationRuntimeContext = createContext<IBuliApplicationRuntime | undefined>(undefined)

interface IBuliRuntimeProviderProps {
  children: ReactNode,
  runtime: IBuliApplicationRuntime
}

export function BuliRuntimeProvider(props: IBuliRuntimeProviderProps) {
  return <BuliApplicationRuntimeContext.Provider value={props.runtime}>{props.children}</BuliApplicationRuntimeContext.Provider>
}

export function useBuliRuntime(): IBuliApplicationRuntime {
  const runtime: IBuliApplicationRuntime | undefined = useContext(BuliApplicationRuntimeContext)
  if (!runtime) throw new Error("Buli runtime not available!")
  return runtime
}

export function useBuli(): IBuliApplicationSnapshot {
  const runtime: IBuliApplicationRuntime = useBuliRuntime()
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
}

export function useSession(sessionId: string): ISessionSnapshot {
  const runtime: IBuliApplicationRuntime = useBuliRuntime()
  const view: ViewSubscribe<ISessionSnapshot> = runtime.view(sessionId)
  return useSyncExternalStore(view.subscribe, view.getSnapshot)
}

interface IBuliApplicationOptions {
  signal: AbortSignal
}

export async function createBuliApplication(options: IBuliApplicationOptions): Promise<IBuliApplicationRuntime> {
  const sessions = new SessionEngine({
    driver: new OpenAiUserBuliInteractionDriver(),
  })

  return new BuliApplicationRuntime({ sessions })
}
