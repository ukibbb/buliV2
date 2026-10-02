import { SessionIndicators } from "@/ui/chat/SessionIndicators"
import { SessionErrors } from "@/ui/chat/SessionErrors"
import { ChatFeedback } from "@/ui/chat/ChatFeedback"
import { ChatInput } from "@/ui/chat/ChatInput"
import { ChatMenu } from "@/ui/chat/ChatMenu"
import { SessionActivity } from "@/ui/chat/SessionActivity"
import { SessionQueue } from "@/ui/chat/SessionQueue"
import { theme } from "@/ui/terminal/theme"

/** Composes independent subscribers; no draft, menu or session state lives here. */
export function Chat(props: { readonly sessionId?: string | undefined }) {
    return (
        <box
            id="chat"
            width="100%"
            minHeight={0}
            flexShrink={1}
            flexDirection="column"
            backgroundColor={theme.surface}
        >
            <SessionIndicators sessionId={props.sessionId} />
            <SessionQueue sessionId={props.sessionId} />
            <ChatMenu />
            <SessionErrors sessionId={props.sessionId} />
            <SessionActivity sessionId={props.sessionId} />
            <ChatInput />
            <ChatFeedback sessionId={props.sessionId} />
        </box>
    )
}
