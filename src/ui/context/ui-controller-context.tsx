import {
    createContext,
    useCallback,
    useContext,
    useSyncExternalStore,
    type ReactNode,
} from "react"

import { BuliUiController, type IBuliUiSnapshot } from "@/ui/ui-controller"

const BuliUiControllerContext = createContext<BuliUiController | undefined>(undefined)

interface IBuliUiControllerProviderProps {
    readonly controller: BuliUiController
    readonly children: ReactNode
}

/** Supplies one UI controller to the connected React tree. */
export function BuliUiControllerProvider(props: IBuliUiControllerProviderProps): ReactNode {
    return (
        <BuliUiControllerContext.Provider value={props.controller}>
            {props.children}
        </BuliUiControllerContext.Provider>
    )
}

/** Returns the UI controller bound to the current React tree. */
export function useBuliUiController(): BuliUiController {
    const controller: BuliUiController | undefined = useContext(BuliUiControllerContext)
    if (!controller) {
        throw new Error("Buli UI controller not available")
    }
    return controller
}

/** Subscribes to navigation without rerendering for draft or menu changes. */
export function useBuliNavigationSnapshot(): Pick<IBuliUiSnapshot, "route" | "authenticationMode"> {
    const controller = useBuliUiController()
    const getRoute = useCallback(() => controller.getSnapshot().route, [controller])
    const getAuthenticationMode = useCallback(
        () => controller.getSnapshot().authenticationMode,
        [controller],
    )
    const route = useSyncExternalStore(controller.subscribe, getRoute)
    const authenticationMode = useSyncExternalStore(controller.subscribe, getAuthenticationMode)
    return { route, authenticationMode }
}

/** Subscribes a component to application UI state. */
export function useBuliUiSnapshot(): IBuliUiSnapshot {
    const controller: BuliUiController = useBuliUiController()
    return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
}
