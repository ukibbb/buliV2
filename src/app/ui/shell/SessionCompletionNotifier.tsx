import { useBlur, useFocus, useRenderer } from "@opentui/react"
import { useEffect, useRef, type ReactNode } from "react"

import { useSession } from "@/app/ui/context/application-context"

interface ISessionCompletionNotifierProps {
    readonly sessionId: string
    readonly now?: () => number
}

export const COMPLETION_NOTIFICATION_MIN_DURATION_MS = 5_000

/** Reports long background run completions for one active session. */
export function SessionCompletionNotifier(
    props: ISessionCompletionNotifierProps,
): ReactNode {
    const session = useSession(props.sessionId)
    const renderer = useRenderer()
    const terminalFocusedRef = useRef(true)
    const runStateRef = useRef({
        initialized: false,
        wasRunning: false,
        startedAt: null as number | null,
    })
    const now = props.now ?? Date.now

    useFocus(() => {
        terminalFocusedRef.current = true
    })
    useBlur(() => {
        terminalFocusedRef.current = false
    })

    useEffect(() => {
        const runState = runStateRef.current
        if (!runState.initialized) {
            runState.initialized = true
            runState.wasRunning = session.isRunning
            runState.startedAt = session.isRunning ? now() : null
            return
        }

        const finishedRun = runState.wasRunning && !session.isRunning
        if (!runState.wasRunning && session.isRunning) {
            runState.startedAt = now()
        }
        runState.wasRunning = session.isRunning
        if (!finishedRun) return

        const startedAt = runState.startedAt
        runState.startedAt = null
        const duration = startedAt === null ? 0 : now() - startedAt
        if (
            !terminalFocusedRef.current
            && duration >= COMPLETION_NOTIFICATION_MIN_DURATION_MS
        ) {
            void renderer.triggerNotification("Run finished", "Buli")
        }
    }, [now, renderer, session.isRunning])

    return null
}
