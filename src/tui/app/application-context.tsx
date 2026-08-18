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
} from "@/application/contracts"
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

export function useBuliApplicationSnapshot(): IBuliApplicationSnapshot {
    // Udostępnij komponentom React aktualny globalny stan aplikacji.
    const runtime = useBuliRuntime()
    // Pobierz runtime zapisany w kontekście React.

    return useSyncExternalStore(
        runtime.subscribe,
        runtime.getSnapshot,
    )
    // Zasubskrybuj zmiany modelu/reasoning i zwracaj stabilny snapshot.
}

export function useSession(sessionId: string): ISessionSnapshot {
    const runtime = useBuliRuntime()
    const session: ISnapshotSource<ISessionSnapshot> =
        runtime.openSession(sessionId)
    return useSyncExternalStore(session.subscribe, session.getSnapshot)
}
