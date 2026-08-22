import { useEffect, useState, type ReactNode } from "react"

import type { IBuliApplication } from "@/app/contracts"
import { BuliRuntimeProvider } from "@/app/ui/context/application-context"
import { BuliUiControllerProvider } from "@/app/ui/context/ui-controller-context"
import { BuliTui } from "@/app/ui/shell/BuliTui"
import { BuliUiController } from "@/app/ui/ui-controller"
import type { IAuthenticationService } from "@/authentication"
import { theme } from "@/terminal/theme"

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
            // Stop UI publications before removing the runtime providers.
            uiController?.dispose()
        }
    }, [props.runtimeTask])

    if (state.type === "startup") {
        return <box
            width="100%"
            height="100%"
            alignItems="center"
            justifyContent="center"
            backgroundColor={theme.background}
        >
            <text
                fg={theme.textMuted}
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
            >Starting Buli...</text>
        </box>
    }
    if (state.type === "error") {
        return <box
            width="100%"
            height="100%"
            alignItems="center"
            justifyContent="center"
            backgroundColor={theme.background}
        >
          <box
            maxWidth={72}
            flexDirection="column"
            border={["left"]}
            borderColor={theme.red}
            backgroundColor={theme.surface}
            padding={2}
            gap={1}
          >
            <text
              fg={theme.red}
              selectionBg={theme.selectionBg}
              selectionFg={theme.selectionFg}
            ><strong>Failed to start Buli</strong></text>
            <text
              fg={theme.text}
              selectionBg={theme.selectionBg}
              selectionFg={theme.selectionFg}
              wrapMode="word"
            >{state.message}</text>
            <text
              fg={theme.textMuted}
              selectionBg={theme.selectionBg}
              selectionFg={theme.selectionFg}
            >Press Ctrl+C to exit</text>
          </box>
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
