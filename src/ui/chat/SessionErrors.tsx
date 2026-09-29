import type { ISessionSnapshot } from "@/sessions"
import { useBuliApplicationSnapshot, useSessionSelector } from "@/ui/context/application-context"
import { useBuliUiSelector } from "@/ui/context/ui-controller-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"
import { ErrorNotice } from "./ErrorNotice"

export function SessionErrors(props: { readonly sessionId: string | undefined }) {
    const state = useSessionSelector(props.sessionId, selectErrors, sameSnapshotFields)
    const inputError = useBuliUiSelector((snapshot) => snapshot.inputError)
    const application = useBuliApplicationSnapshot()
    const catalogError = application.modelCatalog?.status === "error" ? application.modelCatalog.message : undefined
    const errors = collectSessionErrors(state, inputError, catalogError)
    return <>{errors.map((message) => <ErrorNotice key={message} message={message} />)}</>
}

export function collectSessionErrors(
    state: ReturnType<typeof selectErrors>,
    inputError: string | null,
    catalogError?: string,
): string[] {
    const sessionError = state.isCompacting ? undefined : state.errorMessage
    const interruption = !state.isRunning && !state.isCompacting && state.lastRunReason === "aborted"
        && !state.transcriptError && !sessionError ? "Operation aborted" : undefined
    return [...new Set([sessionError, inputError, catalogError, interruption].filter(
        (message): message is string => Boolean(message) && message !== state.transcriptError,
    ))]
}

function selectErrors(session: ISessionSnapshot) {
    const latestMessage = session.messages.at(-1)
    const assistant = session.streamingMessage ?? (latestMessage?.role === "assistant" ? latestMessage : undefined)
    return {
        errorMessage: session.errorMessage,
        transcriptError: assistant?.errorMessage,
        isCompacting: session.isCompacting,
        isRunning: session.isRunning,
        lastRunReason: session.lastRunReason,
    }
}
