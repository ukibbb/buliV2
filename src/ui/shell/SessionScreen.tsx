import type { ReactNode } from "react"

import { Chat } from "@/ui/chat/Chat"
import { SessionTranscript } from "@/ui/sessions/SessionTranscript"

interface ISessionScreenProps {
    readonly sessionId: string
}

/** Owns layout only; live data subscriptions belong to independent sections. */
export function SessionScreen(props: ISessionScreenProps): ReactNode {
    return (
        <box width="100%" flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column">
            <SessionTranscript sessionId={props.sessionId} />
            <Chat sessionId={props.sessionId} />
        </box>
    )
}
