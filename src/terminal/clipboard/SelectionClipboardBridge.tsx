import { useRenderer, useSelectionHandler } from "@opentui/react"
import { useEffect, useRef, type ReactNode } from "react"

import {
    type TClipboardWriter,
    writeTextToClipboard,
} from "@/terminal/clipboard/copy-selection"

const WORD_SELECTION_CLEAR_DELAY_MS = 500

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
    const selectionClearTimerRef = useRef<
        ReturnType<typeof setTimeout> | undefined
    >(undefined)

    useEffect(() => () => {
        if (selectionClearTimerRef.current !== undefined) {
            clearTimeout(selectionClearTimerRef.current)
        }
    }, [])

    useSelectionHandler((selection) => {
        if (selectionClearTimerRef.current !== undefined) {
            clearTimeout(selectionClearTimerRef.current)
            selectionClearTimerRef.current = undefined
        }

        const selectedText = selection.getSelectedText()
        if (!selectedText) return

        if (selection.behavior === "word") {
            // Keep OpenTUI's third-click window alive after copying a word.
            selectionClearTimerRef.current = setTimeout(() => {
                selectionClearTimerRef.current = undefined
                // A newer drag starts before its release emits another selection event.
                if (renderer.getSelection() === selection) {
                    renderer.clearSelection()
                }
            }, WORD_SELECTION_CLEAR_DELAY_MS)
        } else {
            renderer.clearSelection()
        }

        // Serialize writes so a slower host operation cannot overwrite newer text.
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
