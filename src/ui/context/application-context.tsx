import {
    createContext,
    useContext,
    useMemo,
    useSyncExternalStore,
    type ReactNode,
} from "react"
import type {
    IBuliApplication,
    IBuliApplicationSnapshot,
    ISnapshotSource,
} from "@/app/contracts"
import type { ISessionSnapshot } from "@/sessions"
import { useSnapshotSelector } from "@/ui/context/use-snapshot-selector"

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

/** Selects only the session fields owned by the subscribing view. */
export function useSessionSelector<Selection>(
    sessionId: string | undefined,
    select: (snapshot: ISessionSnapshot) => Selection,
    equal?: (previous: Selection, next: Selection) => boolean,
): Selection {
    const runtime = useBuliRuntime()
    const session = useMemo(
        () => sessionId === undefined ? HOME_SESSION_SOURCE : runtime.openSession(sessionId),
        [runtime, sessionId],
    )
    return useSnapshotSelector(session, select, equal)
}

/** Subscribes a component that actually needs the complete session. */
export function useSession(sessionId: string): ISessionSnapshot {
    return useSessionSelector(sessionId, selectSession)
}

const selectSession = (snapshot: ISessionSnapshot) => snapshot

// Home has no live session. Keep its idle source stable and do not open a session.
const HOME_SESSION: ISessionSnapshot = {
    activeBranchId: "main",
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    isRunning: false,
    isCompacting: false,
    pendingToolCallIds: [],
}
const HOME_SESSION_SOURCE: ISnapshotSource<ISessionSnapshot> = {
    getSnapshot: () => HOME_SESSION,
    subscribe: () => () => {},
}
