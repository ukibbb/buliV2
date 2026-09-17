import { MacOSScrollAccel, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useMemo, useRef, type ReactNode } from "react"

import { Chat } from "@/ui/chat/Chat"
import { useSession } from "@/ui/context/application-context"
import { Transcript } from "@/ui/sessions"
import { theme } from "@/ui/terminal/theme"

interface ISessionScreenProps {
  sessionId: string
}

/** Connects one session snapshot to transcript and prompt views. */
export function SessionScreen(props: ISessionScreenProps): ReactNode {
  const session = useSession(props.sessionId)
  const transcriptScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const transcriptScrollAcceleration = useMemo(
    () => new MacOSScrollAccel({ A: 1, tau: 3, maxMultiplier: 8 }),
    [],
  )

  useKeyboard((key) => {
    const isAlt = key.meta || key.option
    if (
      !isAlt
      || key.ctrl
      || key.shift
      || key.super
      || key.hyper
    ) return

    const transcriptScroll = transcriptScrollRef.current
    if (!transcriptScroll) return

    // Keep transcript navigation modified so ordinary editor keys remain untouched.
    if (key.name === "pageup") {
      transcriptScroll.scrollBy(-1, "viewport")
    } else if (key.name === "pagedown") {
      transcriptScroll.scrollBy(1, "viewport")
    } else if (key.name === "home") {
      transcriptScroll.scrollTo(0)
    } else if (key.name === "end") {
      transcriptScroll.scrollTo(Math.max(
        0,
        transcriptScroll.scrollHeight - transcriptScroll.viewport.height,
      ))
    } else {
      return
    }

    key.preventDefault()
    key.stopPropagation()
  })

  return (
    <box
      width="100%"
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
    >
      <scrollbox
        id="session-transcript"
        ref={transcriptScrollRef}
        width="100%"
        minHeight={0}
        flexGrow={1}
        scrollY
        scrollAcceleration={transcriptScrollAcceleration}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        verticalScrollbarOptions={{
          width: 1,
          showArrows: false,
          trackOptions: {
            backgroundColor: theme.surface,
            foregroundColor: theme.textMuted,
          },
        }}
      >
        <Transcript
          messages={session.messages}
          fileChangeProposals={session.fileChangeProposals}
          {...(session.streamingMessage
            ? { streamingMessage: session.streamingMessage }
            : {})}
          {...(session.compactionCheckpoint
            ? { compactionCheckpoint: session.compactionCheckpoint }
            : {})}
          {...(session.activeRunId ? { activeRunId: session.activeRunId } : {})}
          pendingToolCallIds={session.pendingToolCallIds}
        />
      </scrollbox>

      <Chat
        isRunning={session.isRunning}
        isCompacting={session.isCompacting}
        contextUsage={session.contextUsage}
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
