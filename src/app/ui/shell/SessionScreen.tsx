import type { ReactNode } from "react"

import { Chat } from "@/app/ui/chat/Chat"
import { useSession } from "@/app/ui/context/application-context"
import { resolveApprovalKeyboardAction } from "@/app/ui/keyboard-shortcuts"
import { useBuliUiController } from "@/app/ui/context/ui-controller-context"
import { Transcript } from "@/sessions/ui"
import { ToolApprovalPanel } from "@/tools/ui"

interface ISessionScreenProps {
  sessionId: string
}

/** Connects one session snapshot to transcript, approval, and prompt views. */
export function SessionScreen(props: ISessionScreenProps): ReactNode {
  const session = useSession(props.sessionId)
  const controller = useBuliUiController()

  return (
    <box
      width="100%"
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
    >
      {session.pendingToolApproval ? (
        <ToolApprovalPanel
          request={session.pendingToolApproval}
          onResolve={controller.resolveToolApproval}
          onError={controller.setExternalUiError}
          resolveKeyboardAction={resolveApprovalKeyboardAction}
        />
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
