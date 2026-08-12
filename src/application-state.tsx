import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type {
  IBuliApplication,
  ISnapshotSource,
} from "@/application"
import type { ISessionSnapshot } from "@/domain"

export const BuliApplicationRuntimeContext =
  createContext<IBuliApplication | undefined>(undefined)

interface IBuliRuntimeProviderProps {
  children: ReactNode
  runtime: IBuliApplication
}

export function BuliRuntimeProvider(props: IBuliRuntimeProviderProps) {
  return (
    <BuliApplicationRuntimeContext.Provider value={props.runtime}>
      {props.children}
    </BuliApplicationRuntimeContext.Provider>
  )
}

export function useBuliRuntime(): IBuliApplication {
  const runtime = useContext(BuliApplicationRuntimeContext)
  if (!runtime) throw new Error("Buli runtime not available!")
  return runtime
}

export function useSession(sessionId: string): ISessionSnapshot {
  const runtime = useBuliRuntime()
  const session: ISnapshotSource<ISessionSnapshot> =
    runtime.getAgentSession(sessionId)
  return useSyncExternalStore(session.subscribe, session.getSnapshot)
}
