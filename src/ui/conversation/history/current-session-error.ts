import type { ISessionSnapshot } from "@/sessions"

/** Operational error metadata is independent of the currently displayed history page. */
export function currentAssistantError(session: Pick<
    ISessionSnapshot,
    "assistantError" | "streamingMessage" | "isRunning" | "activeRunId" | "isCompacting"
>): ISessionSnapshot["assistantError"] {
    if (session.isCompacting) return undefined
    const candidate = session.streamingMessage ?? session.assistantError
    if (!candidate?.errorMessage) return undefined
    if (session.isRunning && candidate.runId !== session.activeRunId) return undefined
    return { id: candidate.id, runId: candidate.runId, errorMessage: candidate.errorMessage }
}
