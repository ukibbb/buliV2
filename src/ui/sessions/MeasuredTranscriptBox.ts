import {
    BoxRenderable,
    ScrollBoxRenderable,
    type BoxOptions,
    type RenderContext,
} from "@opentui/core"
import { extend } from "@opentui/react"

/** Keeps transcript layout intact while culling offscreen descendants between layout changes. */
export class MeasuredTranscriptBox extends BoxRenderable {
    private needsFullLayoutPass = true
    private measuredWidth: number | undefined

    constructor(context: RenderContext, options: BoxOptions) {
        super(context, options)
        this.onLifecyclePass = () => {
            // OpenTUI 0.5.11 runs lifecycle callbacks before Yoga clears dirtiness.
            this.needsFullLayoutPass = this.getLayoutNode().isDirty()
        }
    }

    protected override onResize(width: number, height: number): void {
        super.onResize(width, height)
        // An ancestor width change need not have dirtied this Yoga node itself.
        if (width !== this.measuredWidth) {
            this.measuredWidth = width
            this.needsFullLayoutPass = true
        }
    }

    private findScrollBox(): ScrollBoxRenderable | undefined {
        let ancestor = this.parent
        while (ancestor !== null) {
            if (ancestor instanceof ScrollBoxRenderable) return ancestor
            ancestor = ancestor.parent
        }
        return undefined
    }

    protected override _hasVisibleChildFilter(): boolean {
        return !this.needsFullLayoutPass && this.findScrollBox() !== undefined
    }

    protected override _getVisibleChildren(): number[] {
        const scrollBox = this.findScrollBox()
        if (scrollBox === undefined) return super._getVisibleChildren()
        const viewport = scrollBox.viewport
        const viewportBottom = viewport.screenY + viewport.height
        const viewportRight = viewport.screenX + viewport.width
        // OpenTUI updates every direct child's geometry before invoking this filter.
        return this.getChildren().filter((child) => (
            child.screenY < viewportBottom
            && child.screenY + child.height > viewport.screenY
            && child.screenX < viewportRight
            && child.screenX + child.width > viewport.screenX
        )).map((child) => child.num)
    }
}

extend({ measuredTranscriptBox: MeasuredTranscriptBox })

declare module "@opentui/react" {
    interface OpenTUIComponents {
        measuredTranscriptBox: typeof MeasuredTranscriptBox
    }
}
