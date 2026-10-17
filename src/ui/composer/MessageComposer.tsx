import { SessionEnvironmentStatus } from "@/ui/composer/status/SessionEnvironmentStatus"
import { SessionErrors } from "@/ui/composer/status/SessionErrors"
import { ModelStatus } from "@/ui/composer/status/ModelStatus"
import { SessionPromptInput } from "@/ui/composer/prompt/SessionPromptInput"
import { CommandPanel } from "@/ui/commands/CommandPanel"
import { PromptSuggestions } from "@/ui/composer/menu/PromptSuggestions"
import { SessionRunActivity } from "@/ui/composer/status/SessionRunActivity"
import { SessionMessageQueue } from "@/ui/composer/queue/SessionMessageQueue"
import { theme } from "@/ui/terminal/theme"

/** Composes independent subscribers; no draft, menu or session state lives here. */
export function MessageComposer(props: { readonly sessionId?: string | undefined }) {
    return (
        <box
            id="chat"
            width="100%"
            minHeight={0}
            flexShrink={1}
            flexDirection="column"
            backgroundColor={theme.surface}
        >
            <SessionEnvironmentStatus sessionId={props.sessionId} />
            <SessionMessageQueue sessionId={props.sessionId} />
            <PromptSuggestions />
            <CommandPanel />
            <SessionErrors sessionId={props.sessionId} />
            <SessionRunActivity sessionId={props.sessionId} />
            <SessionPromptInput sessionId={props.sessionId} />
            <ModelStatus sessionId={props.sessionId} />
        </box>
    )
}
