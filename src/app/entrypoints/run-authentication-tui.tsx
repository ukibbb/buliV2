import { useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"

import type { IAuthenticationService } from "@/authentication"
import { createAuthentication } from "@/app/bootstrap/create-authentication"
import { AuthenticationFlow } from "@/authentication/ui"
import type {
    TAuthenticationMode,
    TAuthenticationOutcome,
} from "@/authentication/ui"
import {
    openExternalUrl,
    runTuiRenderer,
    TerminalViewport,
} from "@/terminal"

/** Runs the standalone login/logout TUI used by dedicated CLI commands. */
export async function runAuthenticationTui(
    mode: TAuthenticationMode,
): Promise<TAuthenticationOutcome> {
    let outcome: TAuthenticationOutcome = "cancelled"

    await runTuiRenderer((lifetime) => {
        const authentication = createAuthentication({ signal: lifetime.signal })
        lifetime.addCleanup(async () => {
            await authentication.service.dispose(lifetime.signal.reason)
        })
        return (
            <StandaloneAuthentication
                mode={mode}
                authentication={authentication.service}
                openUrl={openExternalUrl}
                onClose={(result) => {
                    outcome = result
                    void lifetime.close().catch(() => { })
                }}
            />
        )
    })
    return outcome
}

interface IStandaloneAuthenticationProps {
    readonly mode: TAuthenticationMode
    readonly authentication: IAuthenticationService
    readonly openUrl: (url: string) => unknown | Promise<unknown>
    readonly onClose: (outcome: TAuthenticationOutcome) => void
}

function StandaloneAuthentication(
    props: IStandaloneAuthenticationProps,
): ReactNode {
    const { width, height } = useTerminalDimensions()
    return (
        <TerminalViewport width={width} height={height}>
            <AuthenticationFlow
                mode={props.mode}
                authentication={props.authentication}
                openUrl={props.openUrl}
                onClose={props.onClose}
            />
        </TerminalViewport>
    )
}
