import { MacOSScrollAccel, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useMemo, useRef } from "react"

import { MAIN_BRANCH_ID, type ISessionSnapshot } from "@/sessions"
import { useSessionSelector } from "@/ui/context/application-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"
import { Transcript } from "@/ui/sessions/Transcript"
import { theme } from "@/ui/terminal/theme"

const TRANSCRIPT_SCROLL_ACCELERATION = { A: 1, tau: 3, maxMultiplier: 8 }
const TRANSCRIPT_SCROLLBAR = {
    width: 1,
    showArrows: false,
    trackOptions: { backgroundColor: theme.surface, foregroundColor: theme.textMuted },
}

/** Owns transcript data, scrolling and modified navigation keys, not chat state. */
export function SessionTranscript(props: { readonly sessionId: string }) {
    const session = useSessionSelector(props.sessionId, selectTranscript, sameSnapshotFields)
    const scrollRef = useRef<ScrollBoxRenderable | null>(null)
    const scrollAcceleration = useMemo(() => new MacOSScrollAccel(TRANSCRIPT_SCROLL_ACCELERATION), [])

    useKeyboard((key) => {
        if (!(key.meta || key.option) || key.ctrl || key.shift || key.super || key.hyper) return
        const scroll = scrollRef.current
        if (!scroll) return
        if (!navigateTranscript(scroll, key.name)) return
        key.preventDefault()
        key.stopPropagation()
    })

    return <>
        {session.activeBranchId !== MAIN_BRANCH_ID ? (
            <text fg={theme.amber} wrapMode="word">
                {`Side branch ${session.activeBranchId} · read-only · /return to parent`}
            </text>
        ) : null}
        <scrollbox
            id="session-transcript"
            ref={scrollRef}
            width="100%"
            minHeight={0}
            flexBasis={0}
            flexGrow={1}
            scrollY
            scrollAcceleration={scrollAcceleration}
            stickyScroll
            stickyStart="bottom"
            viewportCulling
            verticalScrollbarOptions={TRANSCRIPT_SCROLLBAR}
        >
            <Transcript
                messages={session.messages}
                fileChangeProposals={session.fileChangeProposals}
                {...(session.streamingMessage ? { streamingMessage: session.streamingMessage } : {})}
                {...(session.compactionCheckpoint ? { compactionCheckpoint: session.compactionCheckpoint } : {})}
                {...(session.compactionProgress ? { compactionProgress: session.compactionProgress } : {})}
                {...(session.activeRunId ? { activeRunId: session.activeRunId } : {})}
                pendingToolCallIds={session.pendingToolCallIds}
            />
        </scrollbox>
    </>
}

function selectTranscript(session: ISessionSnapshot) {
    return {
        activeBranchId: session.activeBranchId,
        messages: session.messages,
        fileChangeProposals: session.fileChangeProposals,
        streamingMessage: session.streamingMessage,
        compactionCheckpoint: session.compactionCheckpoint,
        compactionProgress: session.compactionProgress,
        activeRunId: session.activeRunId,
        pendingToolCallIds: session.pendingToolCallIds,
    }
}

function navigateTranscript(scroll: ScrollBoxRenderable, key: string): boolean {
    if (key === "pageup") {
        scroll.scrollBy(-1, "viewport")
        return true
    }
    if (key === "pagedown") {
        scroll.scrollBy(1, "viewport")
        return true
    }
    if (key === "home") {
        scroll.scrollTo(0)
        return true
    }
    if (key === "end") {
        scroll.scrollTo(Math.max(0, scroll.scrollHeight - scroll.viewport.height))
        return true
    }
    return false
}
