import type {
    ClipboardService,
    CliRenderer,
    Selection,
} from "@opentui/core"

export type TClipboardWriter = Pick<ClipboardService, "writeText">

interface IClipboardTextWrite {
    readonly clipboard: TClipboardWriter
    readonly text: string
    readonly onClipboardWriteError?: (error: unknown) => void
}

/** Writes text to every clipboard destination and normalizes status failures. */
export async function writeTextToClipboard(
    input: IClipboardTextWrite,
): Promise<boolean> {
    try {
        const result = await input.clipboard.writeText(input.text, {
            destination: "all-available",
        })
        const didCopy = result.host.status === "written"
            || result.terminal.status === "attempted"
        if (didCopy) return true

        const error = result.host.status === "failed"
            ? result.host.error
            : new Error(
                `Clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`,
            )
        input.onClipboardWriteError?.(error)
        return false
    } catch (error) {
        input.onClipboardWriteError?.(error)
        return false
    }
}

/** Writes a selection to every available clipboard destination, then reports success. */
export async function copyOpenTuiSelectionToClipboard(input: {
    readonly clipboard: TClipboardWriter
    readonly renderer: Pick<CliRenderer, "clearSelection">
    readonly selection: Pick<Selection, "getSelectedText">
    readonly onClipboardWriteError?: (error: unknown) => void
}): Promise<boolean> {
    const selectedText = input.selection.getSelectedText()
    if (!selectedText) return false

    let writeTask: Promise<boolean>
    try {
        writeTask = writeTextToClipboard({
            clipboard: input.clipboard,
            text: selectedText,
            ...(input.onClipboardWriteError
                ? { onClipboardWriteError: input.onClipboardWriteError }
                : {}),
        })
    } finally {
        input.renderer.clearSelection()
    }
    return writeTask
}
