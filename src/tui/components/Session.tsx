import type { ReactNode } from "react"

import { useSession } from "@/tui/app/application-context"
import { Chat } from "@/tui/components/Chat"
import { ToolApprovalPanel } from "@/tui/components/ToolApprovalPanel"
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
      {session.pendingToolApproval ? (
        <ToolApprovalPanel request={session.pendingToolApproval} />
      ) : (
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
      )}

      <Chat
        isRunning={session.isRunning}
        {...(session.pendingToolApproval
          ? { pendingToolApproval: session.pendingToolApproval }
          : {})}
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
