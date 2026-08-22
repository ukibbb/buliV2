import { useRenderer, useSelectionHandler } from "@opentui/react"
import { useRef, type ReactNode } from "react"

import {
    type TClipboardWriter,
    writeTextToClipboard,
} from "@/terminal/clipboard/copy-selection"

interface ISelectionClipboardBridgeProps {
    readonly clipboard: TClipboardWriter
    readonly onCopyComplete: () => void
    readonly onClipboardWriteError?: (error: unknown) => void
}

/** Subscribes to OpenTUI selections and reports completed clipboard copies. */
export function SelectionClipboardBridge(
    props: ISelectionClipboardBridgeProps,
): ReactNode {
    const renderer = useRenderer()
    const pendingCopyRef = useRef<Promise<void>>(Promise.resolve())

    useSelectionHandler((selection) => {
        const selectedText = selection.getSelectedText()
        if (!selectedText) return

        // Capture and clear immediately, then serialize writes so the newest
        // selection cannot be overwritten by an older, slower host operation.
        renderer.clearSelection()
        const copyTask = pendingCopyRef.current.then(async () => {
            const didCopy = await writeTextToClipboard({
                clipboard: props.clipboard,
                text: selectedText,
                ...(props.onClipboardWriteError
                    ? { onClipboardWriteError: props.onClipboardWriteError }
                    : {}),
            })
            if (didCopy) props.onCopyComplete()
        })
        pendingCopyRef.current = copyTask
    })

    return null
}
