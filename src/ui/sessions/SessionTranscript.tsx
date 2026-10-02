import { LayoutEvents, MacOSScrollAccel, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react"

import { useBuliRuntime } from "@/ui/context/application-context"
import { Transcript } from "@/ui/sessions/Transcript"
import { currentAssistantError } from "@/ui/sessions/current-error"
import { TranscriptController } from "@/ui/sessions/transcript-controller"
import { theme } from "@/ui/terminal/theme"

const TRANSCRIPT_SCROLL_ACCELERATION = { A: 1, tau: 3, maxMultiplier: 8 }
const TRANSCRIPT_SCROLLBAR = {
    width: 1,
    showArrows: false,
    trackOptions: { backgroundColor: theme.surface, foregroundColor: theme.textSecondary },
}

/** Keeps the latest page live; only explicit navigation opens archived pages. */
export function SessionTranscript(props: { readonly sessionId: string }) {
    const runtime = useBuliRuntime()
    const controller = useMemo(() => new TranscriptController(runtime.openSession(props.sessionId)), [runtime, props.sessionId])
    const renderer = useRenderer()
    const scrollRef = useRef<ScrollBoxRenderable | null>(null)
    const anchorRef = useRef<{ block: Renderable; offset: number } | null>(null)
    const subscribe = useCallback((notify: () => void) => {
        let previous = controller.getSnapshot()
        return controller.subscribe(() => {
            const next = controller.getSnapshot()
            const scroll = scrollRef.current
            if (next.navigationRevision !== previous.navigationRevision) anchorRef.current = null
            else if (scroll && next.pageKind === "latest"
                && next.page?.messages[0]?.id !== previous.page?.messages[0]?.id
                && scroll.scrollTop < scroll.scrollHeight - scroll.viewport.height) {
                const block = scroll.content.getChildren().find((child) =>
                    child.id !== "history-older" && child.y + child.height > scroll.viewport.y)
                if (block && !anchorRef.current) {
                    anchorRef.current = { block, offset: block.getLayoutNode().getComputedTop() - scroll.scrollTop }
                }
            }
            previous = next
            notify()
        })
    }, [controller])
    const state = useSyncExternalStore(subscribe, controller.getSnapshot)

    useLayoutEffect(() => {
        const restoreAnchor = () => {
            const anchor = anchorRef.current
            const scroll = scrollRef.current
            anchorRef.current = null
            if (!anchor || !scroll || anchor.block.isDestroyed) return
            // Yoga has the new positions before OpenTUI copies them into renderable.y.
            scroll.scrollTo(anchor.block.getLayoutNode().getComputedTop() - anchor.offset)
        }
        renderer.root.on(LayoutEvents.LAYOUT_CHANGED, restoreAnchor)
        return () => {
            renderer.root.off(LayoutEvents.LAYOUT_CHANGED, restoreAnchor)
            anchorRef.current = null
        }
    }, [renderer, controller])
    const scrollAcceleration = useMemo(() => new MacOSScrollAccel(TRANSCRIPT_SCROLL_ACCELERATION), [])
    const session = state.presentation
    const latest = state.pageKind === "latest"

    useEffect(() => {
        controller.connect()
        void controller.latest()
        return controller.dispose
    }, [controller])

    useLayoutEffect(() => {
        const scroll = scrollRef.current
        if (!scroll) return
        // Explicit navigation starts at the end of the selected page, next to the newer page.
        // Live updates leave the scrollbox's native sticky/manual scroll state intact.
        scroll.scrollTo(Math.max(0, scroll.scrollHeight - scroll.viewport.height))
    }, [controller, state.navigationRevision])

    const returnToLatest = () => { void controller.latest() }
    useKeyboard((key) => {
        if (!(key.meta || key.option) || key.ctrl || key.shift || key.super || key.hyper) return
        const scroll = scrollRef.current
        if (!scroll) return
        if (key.name === "end") returnToLatest()
        else if (key.name === "home") scroll.scrollTo(0)
        else if (key.name === "pageup") scroll.scrollBy(-1, "viewport")
        else if (key.name === "pagedown") scroll.scrollBy(1, "viewport")
        else return
        key.preventDefault()
        key.stopPropagation()
    })

    const page = state.page
    const checkpoint = page?.checkpoint
    const anchored = checkpoint !== undefined && page?.messages.some((message) => message.id === checkpoint.throughMessageId)
    const progress = latest ? session.compactionProgress : undefined
    const stream = latest && session.streamingMessage
        && !page?.messages.some((message) => message.id === session.streamingMessage?.id)
        ? session.streamingMessage : undefined

    return <box width="100%" minHeight={0} flexBasis={0} flexGrow={1} flexDirection="column">
        {state.error && <text fg={theme.amber} wrapMode="none" height={1} selectable={false}
            onMouseDown={returnToLatest}>{`Nie udało się wczytać historii: ${state.error} — ponów`}</text>}
        <box height={1} minHeight={0} flexShrink={1} flexDirection="row">
            {state.loading ? <text selectable={false}>Ładowanie historii…</text>
                : !latest && <>
                    <text id="history-newer" fg={theme.green} selectable={false} flexShrink={0}
                        onMouseDown={() => { void controller.newer() }}>Nowsze wiadomości →</text>
                    <text id="history-latest" fg={theme.green} selectable={false} wrapMode="none" minWidth={0} flexShrink={1}
                        onMouseDown={returnToLatest}>{"   Wróć do bieżącej rozmowy"}</text>
                </>}
        </box>
        <scrollbox id="session-transcript" ref={scrollRef} width="100%" minHeight={0} flexBasis={0} flexGrow={1}
            scrollY scrollAcceleration={scrollAcceleration} stickyScroll={latest} stickyStart="bottom"
            viewportCulling verticalScrollbarOptions={TRANSCRIPT_SCROLLBAR}>
            {page?.olderCursor && <text id="history-older" fg={theme.green} selectable={false} onMouseDown={() => { void controller.older() }}>
                ━━━ Wczytaj starszą historię ━━━
            </text>}
            <Transcript messages={page?.messages ?? []}
                {...(latest && currentAssistantError(session)?.id ? { currentErrorMessageId: currentAssistantError(session)!.id } : {})}
                {...(stream ? { streamingMessage: stream } : {})}
                {...(checkpoint && (latest || anchored) ? { compactionCheckpoint: checkpoint } : {})}
                {...(progress ? { compactionProgress: progress } : {})}
                checkpointOutsidePage={latest}
                {...(latest && session.activeRunId ? { activeRunId: session.activeRunId } : {})}
                pendingToolCallIds={latest ? session.pendingToolCallIds : []} />
        </scrollbox>
    </box>
}
