import { useEffect, useState, type ReactNode } from "react"

import type { IBuliApplication } from "@/application"
import type { IBuliApplicationStartup } from "@/application/startup"
import { BuliRuntimeProvider } from "@/application-state"
import type { IAuthenticationService } from "@/auth/contracts"
import { BuliTui } from "@/tui/Buli"
import { theme } from "@/tui/theme"
import { BuliUiController } from "@/tui/ui-controller"
import { BuliUiControllerProvider } from "@/tui/ui-controller-state"

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
    runtimeTask: Promise<IBuliApplicationStartup>
}

/** Renders startup, application, and startup-failure states. */
export function BuliApplicationLifecycle(
    props: IBuliApplicationLifecycleProps,
): ReactNode {
    const [state, setState] = useState<TBuliLifecycleState>({ type: "startup" })

    useEffect(() => {
        let mounted = true

        void props.runtimeTask.then(
            ({ runtime, authentication }) => {
                if (!mounted) return
                setState({
                    type: "ready",
                    runtime,
                    authentication,
                    uiController: new BuliUiController({ application: runtime }),
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
                <BuliTui authentication={state.authentication} />
            </BuliUiControllerProvider>
        </BuliRuntimeProvider>
    )
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
