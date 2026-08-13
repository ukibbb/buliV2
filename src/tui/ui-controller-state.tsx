import {
    createContext,
    useContext,
    useSyncExternalStore,
    type ReactNode,
} from "react"

import { BuliUiController, type IBuliUiSnapshot } from "@/tui/ui-controller"

const BuliUiControllerContext = createContext<BuliUiController | undefined>(undefined)

interface IBuliUiControllerProviderProps {
    readonly controller: BuliUiController
    readonly children: ReactNode
}

export function BuliUiControllerProvider(props: IBuliUiControllerProviderProps): ReactNode {
    return (
        <BuliUiControllerContext.Provider value={props.controller}>
            {props.children}
        </BuliUiControllerContext.Provider>
    )
}

export function useBuliUiController(): BuliUiController {
    const controller = useContext(BuliUiControllerContext)
    if (!controller) {
        throw new Error("Buli UI controller not available")
    }
    return controller
}

export function useBuliUiSnapshot(): IBuliUiSnapshot {
    const controller = useBuliUiController()
    return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
}
