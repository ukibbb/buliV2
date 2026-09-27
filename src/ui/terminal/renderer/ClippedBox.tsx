import { BoxRenderable } from "@opentui/core"
import { extend, type ExtendedComponentProps } from "@opentui/react"

/** OpenTUI 0.5.12 clamps public sizes to one; clipping must still respect zero rows. */
class ClippedBoxRenderable extends BoxRenderable {
    protected override getScissorRect() {
        const bounds = super.getScissorRect()
        const layout = this.getLayoutNode().getComputedLayout()
        return { ...bounds, width: layout.width, height: layout.height }
    }
}

extend({ clippedBox: ClippedBoxRenderable })

declare module "@opentui/react" {
    interface OpenTUIComponents {
        clippedBox: typeof ClippedBoxRenderable
    }
}

/** Clips descendants to their allocated space without feeding geometry back into layout. */
export function ClippedBox(props: ExtendedComponentProps<typeof ClippedBoxRenderable>) {
    return <clippedBox {...props} overflow="hidden" />
}
