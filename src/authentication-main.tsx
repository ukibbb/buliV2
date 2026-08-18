import { useTerminalDimensions } from "@opentui/react"
import type { ReactNode } from "react"

import type {
    IAuthenticationService,
    TAuthenticationMode,
    TAuthenticationOutcome,
} from "@/auth/contracts"
import { createAuthentication } from "@/auth/create-authentication"
import { AuthenticationFlow } from "@/tui/AuthenticationFlow"
import { Layout } from "@/tui/components/Layout"
import { runTuiRenderer } from "@/tui/renderer-host"

export async function authenticationMain(
    mode: TAuthenticationMode,
): Promise<TAuthenticationOutcome> {
    let outcome: TAuthenticationOutcome = "cancelled"

    await runTuiRenderer((lifetime) => {
        const authentication = createAuthentication({ signal: lifetime.signal })
        lifetime.addCleanup(async () => {
            await authentication.service.dispose?.()
        })
        return (
            <StandaloneAuthentication
                mode={mode}
                authentication={authentication.service}
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
                onClose={props.onClose}
            />
        </Layout>
    )
}
