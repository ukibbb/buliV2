import { Buffer } from "node:buffer"

export const MAX_TOOL_OUTPUT_BYTES = 100_000
export const MAX_TOOL_OUTPUT_LINES = 2_000

const TRUNCATION_MARKER = "... output preview ended"

interface IToolOutputLimits {
    readonly maxBytes?: number
    readonly maxLines?: number
}

/** Keeps model-visible tool output within independent UTF-8 byte and line limits. */
export function truncateToolOutput(
    output: string,
    limits: IToolOutputLimits = {},
): string {
    const maxBytes = limits.maxBytes ?? MAX_TOOL_OUTPUT_BYTES
    const maxLines = limits.maxLines ?? MAX_TOOL_OUTPUT_LINES
    validateLimits(maxBytes, maxLines)

    const lines = splitLines(output)
    if (
        lines.length <= maxLines
        && Buffer.byteLength(output, "utf8") <= maxBytes
    ) {
        return output
    }

    // Rezerwujemy miejsce na marker przed wyborem prefiksu. Dzięki temu wynik
    // po obcięciu sam spełnia limity i kolejne wywołanie pozostaje idempotentne.
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8")
    const maxPrefixBytes = maxBytes - markerBytes - 1
    const maxPrefixLines = maxLines - 1
    const selected: string[] = []
    let selectedBytes = 0

    for (const line of lines) {
        if (selected.length >= maxPrefixLines) break
        const separatorBytes = selected.length > 0 ? 1 : 0
        const availableBytes = maxPrefixBytes - selectedBytes - separatorBytes
        if (availableBytes <= 0) break

        const lineBytes = Buffer.byteLength(line, "utf8")
        if (lineBytes <= availableBytes) {
            selected.push(line)
            selectedBytes += separatorBytes + lineBytes
            continue
        }

        // Iteracja po stringu używa pełnych punktów kodowych, więc nie przetniemy
        // pary surrogate ani wielobajtowego znaku UTF-8 w połowie.
        const partialLine = truncateUtf8Prefix(line, availableBytes)
        if (partialLine) selected.push(partialLine)
        break
    }

    return selected.length > 0
        ? `${selected.join("\n")}\n${TRUNCATION_MARKER}`
        : TRUNCATION_MARKER
}

/** Reports whether a result can be exposed inline without discarding any content. */
export function isToolOutputWithinLimits(
    output: string,
    limits: IToolOutputLimits = {},
): boolean {
    const maxBytes = limits.maxBytes ?? MAX_TOOL_OUTPUT_BYTES
    const maxLines = limits.maxLines ?? MAX_TOOL_OUTPUT_LINES
    validateLimits(maxBytes, maxLines)
    return splitLines(output).length <= maxLines
        && Buffer.byteLength(output, "utf8") <= maxBytes
}

function splitLines(output: string): string[] {
    if (!output) return []
    const lines = output.split("\n")
    if (output.endsWith("\n")) lines.pop()
    return lines
}

function truncateUtf8Prefix(value: string, maxBytes: number): string {
    let result = ""
    let bytes = 0
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, "utf8")
        if (bytes + characterBytes > maxBytes) break
        result += character
        bytes += characterBytes
    }
    return result
}

function validateLimits(maxBytes: number, maxLines: number): void {
    const minimumBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8") + 1
    if (!Number.isSafeInteger(maxBytes) || maxBytes < minimumBytes) {
        throw new RangeError(`maxBytes must be an integer of at least ${minimumBytes}`)
    }
    if (!Number.isSafeInteger(maxLines) || maxLines < 2) {
        throw new RangeError("maxLines must be an integer of at least 2")
    }
}
