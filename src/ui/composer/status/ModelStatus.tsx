import type { ISessionSnapshot } from "@/sessions"
import { ModelStatusLine } from "@/ui/composer/status/ModelStatusLine"
import { getModelReadiness } from "@/ui/composer/status/model-readiness"
import { useBuliApplicationSnapshot, useSessionSelector } from "@/ui/context/application-context"
import { useBuliUiSelector } from "@/ui/context/ui-controller-context"
import { theme } from "@/ui/terminal/theme"
import type { IBuliUiSnapshot } from "@/ui/controller/ui-controller"

/** Model readiness, errors and usage do not invalidate the input or menu. */
export function ModelStatus(props: { readonly sessionId: string | undefined }) {
    const contextUsage = useSessionSelector(props.sessionId, selectContextUsage)
    const application = useBuliApplicationSnapshot()
    const inputError = useBuliUiSelector(selectInputError)
    const feedback = getModelReadiness(application, inputError)

    return <>
        {/* Readiness blocks generation, not editing or commands used to recover it. */}
        {feedback.catalogNotice?.severity === "warning" ? <text
            fg={theme.amber}
            minWidth={0}
            flexShrink={0}
            wrapMode="word"
        >{feedback.catalogNotice.message}</text> : null}
        {application.preferencesWarning ? <text fg={theme.amber} flexShrink={0} wrapMode="word">
            {application.preferencesWarning}
        </text> : null}
        {feedback.providerWarnings.map((warning) => (
            <text key={warning.providerId} fg={theme.amber} flexShrink={0} wrapMode="word">
                {warning.message}
            </text>
        ))}
        <ModelStatusLine
            contextUsage={contextUsage}
            selectedModelName={feedback.selectedModelName}
            reasoningEffort={feedback.reasoningEffort}
        />
    </>
}

function selectContextUsage(session: ISessionSnapshot) {
    return session.contextUsage
}

const selectInputError = (snapshot: IBuliUiSnapshot) => snapshot.inputError
