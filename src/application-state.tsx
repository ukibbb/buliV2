import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react"

import { SessionEngine } from "@/engine"
import { OpenAiUserBuliInteractionDriver } from "@/engine/interaction-driver"
import {
  BuliApplicationRuntime,
  type IBuliApplicationRuntime,
  type IBuliApplicationSnapshot,
} from "@/runtime"


export const BuliApplicationRuntimeContext = createContext<IBuliApplicationRuntime | undefined>(undefined)

interface IBuliRuntimeProviderProps {
  children: ReactNode,
  runtime: IBuliApplicationRuntime
}

export function BuliRuntimeProvider(props: IBuliRuntimeProviderProps) {
  return <BuliApplicationRuntimeContext.Provider value={props.runtime}> {props.children} </BuliApplicationRuntimeContext.Provider>
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

export function useSession(sessionId: string): SessionEngine {
  const runtime: IBuliApplicationRuntime = useBuliRuntime()
  const session = runtime.sessions.get(sessionId)
  return useSyncExternalStore(session.subscribe, session.getSnapshot)
}

export function createBuliApplication(): BuliApplicationRuntime {
  const sessions = new SessionEngine({
    driver: new OpenAiUserBuliInteractionDriver(),
  })

  return new BuliApplicationRuntime({ sessions })
}
