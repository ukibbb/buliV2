import { useEffect, type ReactNode } from "react"

import type { ISessionSnapshot } from "@/sessions"
import { useSessionSelector } from "@/ui/context/application-context"
import type { IHerdrAgentReporter } from "@/ui/integrations/herdr/herdr-agent-reporter"

interface IHerdrAgentStateReporterProps {
    /** Session shown on screen; undefined on the home screen. */
    readonly sessionId: string | undefined
    readonly reporter: IHerdrAgentReporter
}

/** Mirrors the visible session's run state into Herdr as working/idle. */
export function HerdrAgentStateReporter(props: IHerdrAgentStateReporterProps): ReactNode {
    const isRunning = useSessionSelector(props.sessionId, selectIsRunning)
    const { reporter } = props

    useEffect(() => {
        reporter.report(isRunning ? "working" : "idle")
    }, [reporter, isRunning])

    return null
}

const selectIsRunning = (session: ISessionSnapshot) => session.isRunning
