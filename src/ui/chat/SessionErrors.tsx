import type { ISessionSnapshot } from "@/sessions"
import { useBuliApplicationSnapshot, useSessionSelector } from "@/ui/context/application-context"
import { useBuliUiSelector } from "@/ui/context/ui-controller-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"
import { ErrorNotice } from "./ErrorNotice"
import { currentAssistantError } from "@/ui/sessions/current-error"

export function SessionErrors(props: { readonly sessionId: string | undefined }) {
    const state = useSessionSelector(props.sessionId, selectErrors, sameSnapshotFields)
    const inputError = useBuliUiSelector((snapshot) => snapshot.inputError)
    const menuError = useBuliUiSelector((snapshot) => snapshot.menu?.errorMessage)
    const application = useBuliApplicationSnapshot()
    const catalogError = application.modelCatalog?.status === "error" ? application.modelCatalog.message : undefined
    const errors = collectSessionErrors(state, inputError, catalogError, menuError ?? undefined)
    return <>{errors.map((message) => <ErrorNotice key={message} message={message} />)}</>
}

export function collectSessionErrors(
    state: ReturnType<typeof selectErrors>,
    inputError: string | null,
    catalogError?: string,
    menuError?: string,
): string[] {
    const sessionError = state.isCompacting ? undefined : state.errorMessage
    const interruption = !state.isRunning && !state.isCompacting && state.lastRunReason === "aborted"
        && !state.transcriptError && !sessionError ? "Operation aborted" : undefined
    return [...new Set([state.transcriptError, sessionError, inputError, catalogError, menuError, interruption].filter(
        (message): message is string => Boolean(message),
    ))]
}

function selectErrors(session: ISessionSnapshot) {
    const assistant = currentAssistantError(session)
    return {
        errorMessage: session.errorMessage,
        transcriptError: assistant?.errorMessage,
        isCompacting: session.isCompacting,
        isRunning: session.isRunning,
        lastRunReason: session.lastRunReason,
    }
}
