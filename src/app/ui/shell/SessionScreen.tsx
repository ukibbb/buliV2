import type { ScrollBoxRenderable } from "@opentui/core"
import {
  useBlur,
  useFocus,
  useKeyboard,
  useRenderer,
} from "@opentui/react"
import { useEffect, useRef, type ReactNode } from "react"

import { Chat } from "@/app/ui/chat/Chat"
import { useSession } from "@/app/ui/context/application-context"
import { resolveApprovalKeyboardAction } from "@/app/ui/keyboard-shortcuts"
import { useBuliUiController } from "@/app/ui/context/ui-controller-context"
import { Transcript } from "@/sessions/ui"
import { theme } from "@/terminal/theme"
import { ToolApprovalPanel } from "@/tools/ui"

interface ISessionScreenProps {
  sessionId: string
  now?: () => number
}

export const COMPLETION_NOTIFICATION_MIN_DURATION_MS = 5_000

/** Connects one session snapshot to transcript, approval, and prompt views. */
export function SessionScreen(props: ISessionScreenProps): ReactNode {
  const session = useSession(props.sessionId)
  const controller = useBuliUiController()
  const renderer = useRenderer()
  const transcriptScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const terminalFocusedRef = useRef(true)
  const runStateRef = useRef({
    initialized: false,
    wasRunning: false,
    startedAt: null as number | null,
  })
  const now = props.now ?? Date.now

  useFocus(() => {
    terminalFocusedRef.current = true
  })
  useBlur(() => {
    terminalFocusedRef.current = false
  })

  useKeyboard((key) => {
    const isAlt = key.meta || key.option
    if (
      session.pendingToolApproval
      || !isAlt
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

  useEffect(() => {
    const runState = runStateRef.current
    if (!runState.initialized) {
      runState.initialized = true
      runState.wasRunning = session.isRunning
      runState.startedAt = session.isRunning ? now() : null
      return
    }

    const finishedRun = runState.wasRunning && !session.isRunning
    if (!runState.wasRunning && session.isRunning) {
      runState.startedAt = now()
    }
    runState.wasRunning = session.isRunning
    if (!finishedRun) return

    const startedAt = runState.startedAt
    runState.startedAt = null
    const duration = startedAt === null ? 0 : now() - startedAt
    // Focus and duration guards avoid foreground noise and alerts for quick runs.
    if (
      !terminalFocusedRef.current
      && duration >= COMPLETION_NOTIFICATION_MIN_DURATION_MS
    ) {
      // Unsupported terminals return false, making this best-effort call harmless.
      void renderer.triggerNotification("Run finished", "Buli")
    }
  }, [now, renderer, session.isRunning])

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
          id="session-transcript"
          ref={transcriptScrollRef}
          width="100%"
          minHeight={0}
          flexGrow={1}
          scrollY
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
            {...(session.streamingMessage
              ? { streamingMessage: session.streamingMessage }
              : {})}
            {...(session.activeRunId ? { activeRunId: session.activeRunId } : {})}
            pendingToolCallIds={session.pendingToolCallIds}
          />
        </scrollbox>
      )}

      <Chat
        isRunning={session.isRunning}
        isCompacting={session.isCompacting}
        contextUsage={session.contextUsage}
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
