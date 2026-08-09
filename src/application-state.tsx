import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type {
  IBuliApplicationClient,
  ISnapshotSource,
} from "@/application"
import type { ISessionSnapshot } from "@/domain"

export const BuliApplicationRuntimeContext =
  createContext<IBuliApplicationClient | undefined>(undefined)

interface IBuliRuntimeProviderProps {
  children: ReactNode
  runtime: IBuliApplicationClient
}

export function BuliRuntimeProvider(props: IBuliRuntimeProviderProps) {
  return (
    <BuliApplicationRuntimeContext.Provider value={props.runtime}>
      {props.children}
    </BuliApplicationRuntimeContext.Provider>
  )
}

export function useBuliRuntime(): IBuliApplicationClient {
  const runtime = useContext(BuliApplicationRuntimeContext)
  if (!runtime) throw new Error("Buli runtime not available!")
  return runtime
}

export function useSession(sessionId: string): ISessionSnapshot {
  const runtime = useBuliRuntime()
  const view: ISnapshotSource<ISessionSnapshot> = runtime.view(sessionId)
  return useSyncExternalStore(view.subscribe, view.getSnapshot)
}
