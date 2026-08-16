import type { ReactNode } from "react"

import { useSession } from "@/application-state"
import { Chat } from "@/tui/components/Chat"
import { Transcript } from "@/tui/components/Transcript"

interface ISessionScreenProps {
  sessionId: string
}

export function SessionScreen(props: ISessionScreenProps): ReactNode {
  const session = useSession(props.sessionId)

  return (
    <box
      width="100%"
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
    >
      <scrollbox
        width="100%"
        minHeight={0}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
      >
        <Transcript
          messages={session.messages}
          {...(session.streamingMessage
            ? { streamingMessage: session.streamingMessage }
            : {})}
          pendingToolCallIds={session.pendingToolCallIds}
        />
      </scrollbox>

      <Chat
        isRunning={session.isRunning}
        pendingSteeringMessages={session.pendingSteeringMessages}
        pendingFollowUpMessages={session.pendingFollowUpMessages}
        {...(session.lastRunReason
          ? { lastRunReason: session.lastRunReason }
          : {})}
        {...(session.errorMessage
          ? { errorMessage: session.errorMessage }
          : {})}
      />
    </box>
  )
}
