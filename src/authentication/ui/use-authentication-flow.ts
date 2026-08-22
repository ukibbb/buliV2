import {
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react"

import type { IAuthenticationService } from "@/authentication/contracts"
import {
    AuthenticationFlowController,
    type TAuthenticationFlowState,
} from "@/authentication/ui/authentication-flow-controller"
import type {
    TAuthenticationMode,
    TAuthenticationOutcome,
} from "@/authentication/ui/types"

interface IUseAuthenticationFlowOptions {
    readonly mode: TAuthenticationMode
    readonly authentication: IAuthenticationService
    readonly onClose: (outcome: TAuthenticationOutcome) => void
    readonly openUrl: (url: string) => unknown | Promise<unknown>
}

interface IAuthenticationFlowBinding {
    readonly controller: AuthenticationFlowController
    readonly state: TAuthenticationFlowState
}

/** Adapts one screen-scoped authentication controller to the React lifecycle. */
export function useAuthenticationFlow(
    options: IUseAuthenticationFlowOptions,
): IAuthenticationFlowBinding {
    const onCloseRef = useRef(options.onClose)
    const openUrlRef = useRef(options.openUrl)
    onCloseRef.current = options.onClose
    openUrlRef.current = options.openUrl

    // Kontroler jest zasobem jednej instancji ekranu. Call sites montują nową
    // instancję dla nowego mode, a refy powyżej dostarczają najnowsze callbacki.
    const [controller] = useState(() => new AuthenticationFlowController({
        mode: options.mode,
        authentication: options.authentication,
        onClose: (outcome) => onCloseRef.current(outcome),
        openUrl: (url) => openUrlRef.current(url),
    }))
    const state = useSyncExternalStore(
        controller.subscribe,
        controller.getSnapshot,
    )

    useEffect(() => {
        controller.start()
        return () => {
            controller.dispose(new Error("Authentication screen unmounted"))
        }
    }, [controller])

    return { controller, state }
}
