import type { ScrollBoxRenderable } from "@opentui/core"
import { useCallback, useLayoutEffect, useRef } from "react"

const RENDERABLE_RESIZE_EVENT = "resize"
const SELECTION_CENTER_DIVISOR = 2

/**
 * Keep one-row menu items visible after selection, list or viewport changes.
 * Pass undefined items while closed so reopening reattaches the resize listeners.
 */
export function useMenuSelectionScroll(
    selectedIndex: number,
    items: readonly unknown[] | undefined,
) {
    const scrollRef = useRef<ScrollBoxRenderable | null>(null)
    const revealSelection = useCallback(() => {
        const scroll = scrollRef.current
        if (!scroll) return
        const centerOffset = Math.floor(scroll.viewport.height / SELECTION_CENTER_DIVISOR)
        scroll.scrollTo(Math.max(0, selectedIndex - centerOffset))
    }, [selectedIndex])

    useLayoutEffect(() => {
        const scroll = scrollRef.current
        if (!scroll) return
        // These events follow ScrollBox's own scrollbar calculations. Do not replace
        // contentOptions/viewportOptions.onSizeChange: those handlers belong to it.
        scroll.viewport.on(RENDERABLE_RESIZE_EVENT, revealSelection)
        scroll.content.on(RENDERABLE_RESIZE_EVENT, revealSelection)
        revealSelection()
        return () => {
            scroll.viewport.off(RENDERABLE_RESIZE_EVENT, revealSelection)
            scroll.content.off(RENDERABLE_RESIZE_EVENT, revealSelection)
        }
    }, [revealSelection, items])

    return scrollRef
}
