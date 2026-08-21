import { useEffect, useState, type ReactNode } from "react"

import type { IBuliApplication } from "@/application/contracts"
import { BuliRuntimeProvider } from "@/tui/app/application-context"
import type { IAuthenticationService } from "@/auth/contracts"
import { BuliTui } from "@/tui/app/BuliTui"
import { theme } from "@/tui/theme"
import { BuliUiController } from "@/tui/app/ui-controller"
import { BuliUiControllerProvider } from "@/tui/app/ui-controller-context"

type TBuliLifecycleState =
    | { type: "startup" }
    | {
        type: "ready"
        runtime: IBuliApplication
        authentication: IAuthenticationService
        uiController: BuliUiController
    }
    | { type: "error"; message: string }

interface IBuliApplicationLifecycleProps {
    runtimeTask: Promise<{
        runtime: IBuliApplication
        authentication: IAuthenticationService
    }>
    openUrl: (url: string) => unknown | Promise<unknown>
}

/** Renders startup, application, and startup-failure states. */
export function BuliApplicationLifecycle(
    props: IBuliApplicationLifecycleProps,
): ReactNode {
    const [state, setState] = useState<TBuliLifecycleState>({ type: "startup" })

    useEffect(() => {
        let mounted = true
        let uiController: BuliUiController | undefined

        void props.runtimeTask.then(
            ({ runtime, authentication }) => {
                if (!mounted) return
                uiController = new BuliUiController({ application: runtime })
                setState({
                    type: "ready",
                    runtime,
                    authentication,
                    uiController,
                })
            },
            (error: unknown) => {
                if (mounted) {
                    setState({ type: "error", message: errorMessage(error) })
                }
            },
        )

        return () => {
            mounted = false
            // Controller pożycza runtime, ale posiada własne async UI operations
            // i subskrypcje. Lifecycle zamyka je przed usunięciem providerów React.
            uiController?.dispose()
        }
    }, [props.runtimeTask])

    if (state.type === "startup") {
        return <text fg={theme.textMuted}>Starting Buli...</text>
    }
    if (state.type === "error") {
        return <box flexDirection="column">
            <text fg={theme.red}>Failed to start Buli</text>
            <text fg={theme.red}>{state.message}</text>
            <text fg={theme.textMuted}>Press Ctrl+C to exit</text>
        </box>
    }

    return (
        <BuliRuntimeProvider runtime={state.runtime}>
            <BuliUiControllerProvider controller={state.uiController}>
                <BuliTui
                    authentication={state.authentication}
                    openUrl={props.openUrl}
                />
            </BuliUiControllerProvider>
        </BuliRuntimeProvider>
    )
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
