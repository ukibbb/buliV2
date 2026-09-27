import type { ISessionSnapshot } from "@/sessions"
import { ChatStatus } from "@/ui/chat/ChatStatus"
import { getModelFeedback } from "@/ui/chat/model-feedback"
import { useBuliApplicationSnapshot, useSessionSelector } from "@/ui/context/application-context"
import { useBuliUiSelector } from "@/ui/context/ui-controller-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"
import { theme } from "@/ui/terminal/theme"
import type { IBuliUiSnapshot } from "@/ui/ui-controller"

/** Model readiness, errors and usage do not invalidate the input or menu. */
export function ChatFeedback(props: { readonly sessionId: string | undefined }) {
    const session = useSessionSelector(props.sessionId, selectStatus, sameSnapshotFields)
    const application = useBuliApplicationSnapshot()
    const inputError = useBuliUiSelector(selectInputError)
    const feedback = getModelFeedback(application, inputError)

    return <>
        {/* Readiness blocks generation, not editing or commands used to recover it. */}
        {feedback.catalogNotice ? <text
            fg={feedback.catalogNotice.severity === "error" ? theme.red : theme.amber}
            minWidth={0}
            flexShrink={0}
            wrapMode="word"
        >{feedback.catalogNotice.message}</text> : null}
        {feedback.providerWarnings.map((warning) => (
            <text key={warning.providerId} fg={theme.amber} flexShrink={0} wrapMode="word">
                {warning.message}
            </text>
        ))}
        <ChatStatus
            {...session}
            inputError={inputError}
            selectedModelName={feedback.selectedModelName}
            reasoningEffort={feedback.reasoningEffort}
        />
    </>
}

function selectStatus(session: ISessionSnapshot) {
    return {
        isRunning: session.isRunning,
        isCompacting: session.isCompacting,
        contextUsage: session.contextUsage,
        lastRunReason: session.lastRunReason,
        errorMessage: session.errorMessage,
    }
}

const selectInputError = (snapshot: IBuliUiSnapshot) => snapshot.inputError
