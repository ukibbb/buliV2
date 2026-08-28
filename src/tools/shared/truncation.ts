import { Buffer } from "node:buffer"

// Ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86 (c) 2025 Mario Zechner, MIT License.
export const DEFAULT_MAX_LINES = 2_000
export const DEFAULT_MAX_BYTES = 50 * 1_024
export const GREP_MAX_LINE_LENGTH = 500

export interface ITruncationResult {
    readonly content: string
    readonly truncated: boolean
    readonly truncatedBy: "bytes" | "lines" | null
    readonly outputLines: number
    readonly firstLineExceedsLimit: boolean
}

interface ITruncationOptions {
    readonly maxLines?: number
    readonly maxBytes?: number
}

export function formatSize(bytes: number): string {
    if (bytes < 1_024) return `${bytes}B`
    if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`
    return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`
}

/** Keeps complete leading lines until Pi's line or byte limit is reached. */
export function truncateHead(
    content: string,
    options: ITruncationOptions = {},
): ITruncationResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const totalBytes = Buffer.byteLength(content, "utf-8")
    const lines = splitLinesForCounting(content)

    if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return {
            content,
            truncated: false,
            truncatedBy: null,
            outputLines: lines.length,
            firstLineExceedsLimit: false,
        }
    }

    if (Buffer.byteLength(lines[0]!, "utf-8") > maxBytes) {
        return {
            content: "",
            truncated: true,
            truncatedBy: "bytes",
            outputLines: 0,
            firstLineExceedsLimit: true,
        }
    }

    const outputLines: string[] = []
    let outputBytes = 0
    let truncatedBy: "bytes" | "lines" = "lines"
    for (let index = 0; index < lines.length && index < maxLines; index += 1) {
        const line = lines[index]!
        const lineBytes = Buffer.byteLength(line, "utf-8")
            + (index > 0 ? 1 : 0)
        if (outputBytes + lineBytes > maxBytes) {
            truncatedBy = "bytes"
            break
        }
        outputLines.push(line)
        outputBytes += lineBytes
    }

    if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
        truncatedBy = "lines"
    }
    return {
        content: outputLines.join("\n"),
        truncated: true,
        truncatedBy,
        outputLines: outputLines.length,
        firstLineExceedsLimit: false,
    }
}

export function truncateLine(
    line: string,
    maxCharacters = GREP_MAX_LINE_LENGTH,
): { readonly text: string; readonly wasTruncated: boolean } {
    if (line.length <= maxCharacters) {
        return { text: line, wasTruncated: false }
    }
    return {
        text: `${line.slice(0, maxCharacters)}... [truncated]`,
        wasTruncated: true,
    }
}

function splitLinesForCounting(content: string): string[] {
    if (content.length === 0) return []
    const lines = content.split("\n")
    if (content.endsWith("\n")) lines.pop()
    return lines
}
