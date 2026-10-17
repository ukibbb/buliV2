import type { ReactNode } from "react"

import { MessageComposer } from "@/ui/composer/MessageComposer"
import { SessionConversationHistory } from "@/ui/conversation/history/SessionConversationHistory"

interface ISessionScreenProps {
    readonly sessionId: string
}

/** Owns layout only; live data subscriptions belong to independent sections. */
export function SessionScreen(props: ISessionScreenProps): ReactNode {
    return (
        <box width="100%" flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column">
            <SessionConversationHistory sessionId={props.sessionId} />
            <MessageComposer sessionId={props.sessionId} />
        </box>
    )
}
