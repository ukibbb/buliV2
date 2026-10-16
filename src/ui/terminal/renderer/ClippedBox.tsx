import { LayoutEvents, type BoxRenderable } from "@opentui/core"
import { useRenderer, type BoxProps } from "@opentui/react"
import { useLayoutEffect, useRef } from "react"

/** Clips descendants, suppressing paint when native dimensions round zero up to one. */
export function ClippedBox(props: BoxProps) {
    const renderer = useRenderer()
    const box = useRef<BoxRenderable | null>(null)
    useLayoutEffect(() => {
        const updateOpacity = () => {
            if (box.current && !box.current.isDestroyed) {
                box.current.opacity = box.current.getLayout().height === 0 ? 0 : (props.opacity ?? 1)
            }
        }
        renderer.root.on(LayoutEvents.LAYOUT_CHANGED, updateOpacity)
        return () => { renderer.root.off(LayoutEvents.LAYOUT_CHANGED, updateOpacity) }
    }, [renderer, props.opacity])
    return <box {...props} ref={box} overflow="hidden" />
}
