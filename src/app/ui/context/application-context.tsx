import {
    createContext,
    useContext,
    useSyncExternalStore,
    type ReactNode,
} from "react"
import type {
    IBuliApplication,
    IBuliApplicationSnapshot,
    ISnapshotSource,
} from "@/app/contracts"
import type { ISessionSnapshot } from "@/sessions"

/** Runtime contract context shared by connected application views. */
export const BuliApplicationRuntimeContext =
    createContext<IBuliApplication | undefined>(undefined)

interface IBuliRuntimeProviderProps {
    children: ReactNode
    runtime: IBuliApplication
}

/** Supplies the application runtime to connected terminal views. */
export function BuliRuntimeProvider(props: IBuliRuntimeProviderProps) {
    return (
        <BuliApplicationRuntimeContext.Provider value={props.runtime}>
            {props.children}
        </BuliApplicationRuntimeContext.Provider>
    )
}

/** Returns the application runtime bound to the current UI tree. */
export function useBuliRuntime(): IBuliApplication {
    const runtime = useContext(BuliApplicationRuntimeContext)
    if (!runtime) throw new Error("Buli runtime not available!")
    return runtime
}

/** Subscribes a component to global application state. */
export function useBuliApplicationSnapshot(): IBuliApplicationSnapshot {
    const runtime = useBuliRuntime()

    return useSyncExternalStore(
        runtime.subscribe,
        runtime.getSnapshot,
    )
}

/** Subscribes a component to one live session snapshot. */
export function useSession(sessionId: string): ISessionSnapshot {
    const runtime = useBuliRuntime()
    const session: ISnapshotSource<ISessionSnapshot> =
        runtime.openSession(sessionId)
    return useSyncExternalStore(session.subscribe, session.getSnapshot)
}
