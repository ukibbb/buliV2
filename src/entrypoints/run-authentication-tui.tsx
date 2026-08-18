import { useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"

import type {
    IAuthenticationService,
} from "@/auth/contracts"
import { createAuthentication } from "@/composition/create-authentication"
import { AuthenticationFlow } from "@/tui/authentication/AuthenticationFlow"
import type {
    TAuthenticationMode,
    TAuthenticationOutcome,
} from "@/tui/authentication/types"
import { Layout } from "@/tui/components/Layout"
import { openExternalUrl } from "@/tui/host/open-url"
import { runTuiRenderer } from "@/tui/host/run-tui-renderer"

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
        <Layout width={width} height={height}>
            <AuthenticationFlow
                mode={props.mode}
                authentication={props.authentication}
                openUrl={props.openUrl}
                onClose={props.onClose}
            />
        </Layout>
    )
}
