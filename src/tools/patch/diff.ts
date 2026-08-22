import { Buffer } from "node:buffer"

export interface IUnifiedDiffOptions {
    readonly oldPath: string | null
    readonly newPath: string | null
    readonly oldText: string
    readonly newText: string
    readonly contextLines?: number
    readonly maxBytes?: number
}

export interface IUnifiedDiff {
    readonly text: string
    readonly additions: number
    readonly deletions: number
}

/** Reports that rendering a unified diff exceeded its configured byte limit. */
export class UnifiedDiffTooLargeError extends Error {
    constructor() {
        super("Unified diff exceeds its byte limit")
        this.name = "UnifiedDiffTooLargeError"
    }
}

type TLineEnding = "" | "\n" | "\r" | "\r\n"
type TDiffKind = "equal" | "add" | "delete"

interface ITextLine {
    readonly text: string
    readonly ending: TLineEnding
}

interface IDiffOperation {
    readonly kind: TDiffKind
    readonly line: ITextLine
}

interface IDiffRecord extends IDiffOperation {
    readonly oldLine: number
    readonly newLine: number
}

interface IHunkRange {
    start: number
    end: number
}

const DEFAULT_CONTEXT_LINES = 3
const MAX_LCS_CELLS = 1_000_000

/** Creates a deterministic, line-oriented unified diff for exact text states. */
export function createUnifiedDiff(options: IUnifiedDiffOptions): IUnifiedDiff {
    if (options.oldPath === null && options.newPath === null) {
        throw new TypeError("A unified diff needs an old or new path")
    }
    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES
    if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
        throw new TypeError("contextLines must be a non-negative integer")
    }
    const maxBytes = options.maxBytes
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
        throw new TypeError("maxBytes must be a non-negative integer")
    }

    const operations = diffLines(
        splitExactLines(options.oldText),
        splitExactLines(options.newText),
    )
    const additions = operations.filter(({ kind }) => kind === "add").length
    const deletions = operations.filter(({ kind }) => kind === "delete").length
    const records = numberOperations(operations)
    const ranges = hunkRanges(records, contextLines)
    const parts: string[] = []
    let byteLength = 0
    const append = (part: string): void => {
        const partBytes = Buffer.byteLength(part, "utf8")
        if (maxBytes !== undefined && partBytes > maxBytes - byteLength) {
            throw new UnifiedDiffTooLargeError()
        }
        parts.push(part)
        byteLength += partBytes
    }
    append(`--- ${displayDiffPath("a", options.oldPath)}\n`)
    append(`+++ ${displayDiffPath("b", options.newPath)}\n`)

    for (const range of ranges) {
        const recordsInHunk = records.slice(range.start, range.end)
        const first = recordsInHunk[0]
        if (!first) continue
        const oldCount = recordsInHunk.filter(({ kind }) => kind !== "add").length
        const newCount = recordsInHunk.filter(({ kind }) => kind !== "delete").length
        const oldStart = oldCount === 0 ? first.oldLine - 1 : first.oldLine
        const newStart = newCount === 0 ? first.newLine - 1 : first.newLine
        append(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`)

        for (const record of recordsInHunk) {
            const prefix = record.kind === "add"
                ? "+"
                : record.kind === "delete" ? "-" : " "
            append(`${prefix}${record.line.text}\n`)
            if (record.line.ending === "") {
                append("\\ No newline at end of file\n")
            }
        }
    }

    return { text: parts.join(""), additions, deletions }
}

function splitExactLines(text: string): readonly ITextLine[] {
    const lines: ITextLine[] = []
    let start = 0
    let index = 0

    while (index < text.length) {
        const character = text[index]
        if (character !== "\r" && character !== "\n") {
            index += 1
            continue
        }

        const ending: TLineEnding = character === "\r" && text[index + 1] === "\n"
            ? "\r\n"
            : character
        lines.push({ text: text.slice(start, index), ending })
        index += ending.length
        start = index
    }

    if (start < text.length) lines.push({ text: text.slice(start), ending: "" })
    return lines
}

function diffLines(
    oldLines: readonly ITextLine[],
    newLines: readonly ITextLine[],
): readonly IDiffOperation[] {
    let prefixLength = 0
    while (
        prefixLength < oldLines.length
        && prefixLength < newLines.length
        && sameLine(oldLines[prefixLength], newLines[prefixLength])
    ) prefixLength += 1

    let suffixLength = 0
    while (
        suffixLength < oldLines.length - prefixLength
        && suffixLength < newLines.length - prefixLength
        && sameLine(
            oldLines[oldLines.length - suffixLength - 1],
            newLines[newLines.length - suffixLength - 1],
        )
    ) suffixLength += 1

    const operations: IDiffOperation[] = []
    for (let index = 0; index < prefixLength; index += 1) {
        const line = oldLines[index]
        if (line) operations.push({ kind: "equal", line })
    }

    const oldMiddle = oldLines.slice(prefixLength, oldLines.length - suffixLength)
    const newMiddle = newLines.slice(prefixLength, newLines.length - suffixLength)
    operations.push(...diffMiddle(oldMiddle, newMiddle))

    for (let index = oldLines.length - suffixLength; index < oldLines.length; index += 1) {
        const line = oldLines[index]
        if (line) operations.push({ kind: "equal", line })
    }
    return operations
}

function diffMiddle(
    oldLines: readonly ITextLine[],
    newLines: readonly ITextLine[],
): readonly IDiffOperation[] {
    if (oldLines.length === 0) {
        return newLines.map((line) => ({ kind: "add" as const, line }))
    }
    if (newLines.length === 0) {
        return oldLines.map((line) => ({ kind: "delete" as const, line }))
    }
    if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
        return [
            ...oldLines.map((line) => ({ kind: "delete" as const, line })),
            ...newLines.map((line) => ({ kind: "add" as const, line })),
        ]
    }

    const width = newLines.length + 1
    const table = new Uint32Array((oldLines.length + 1) * width)
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
            const cell = oldIndex * width + newIndex
            if (sameLine(oldLines[oldIndex], newLines[newIndex])) {
                table[cell] = (table[(oldIndex + 1) * width + newIndex + 1] ?? 0) + 1
            } else {
                table[cell] = Math.max(
                    table[(oldIndex + 1) * width + newIndex] ?? 0,
                    table[oldIndex * width + newIndex + 1] ?? 0,
                )
            }
        }
    }

    const operations: IDiffOperation[] = []
    let oldIndex = 0
    let newIndex = 0
    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        const oldLine = oldLines[oldIndex]
        const newLine = newLines[newIndex]
        if (sameLine(oldLine, newLine) && oldLine) {
            operations.push({ kind: "equal", line: oldLine })
            oldIndex += 1
            newIndex += 1
        } else if (
            (table[(oldIndex + 1) * width + newIndex] ?? 0)
            >= (table[oldIndex * width + newIndex + 1] ?? 0)
        ) {
            if (oldLine) operations.push({ kind: "delete", line: oldLine })
            oldIndex += 1
        } else {
            if (newLine) operations.push({ kind: "add", line: newLine })
            newIndex += 1
        }
    }
    while (oldIndex < oldLines.length) {
        const line = oldLines[oldIndex]
        if (line) operations.push({ kind: "delete", line })
        oldIndex += 1
    }
    while (newIndex < newLines.length) {
        const line = newLines[newIndex]
        if (line) operations.push({ kind: "add", line })
        newIndex += 1
    }
    return operations
}

function sameLine(
    left: ITextLine | undefined,
    right: ITextLine | undefined,
): boolean {
    return left !== undefined
        && right !== undefined
        && left.text === right.text
        && left.ending === right.ending
}

function numberOperations(
    operations: readonly IDiffOperation[],
): readonly IDiffRecord[] {
    const records: IDiffRecord[] = []
    let oldLine = 1
    let newLine = 1
    for (const operation of operations) {
        records.push({ ...operation, oldLine, newLine })
        if (operation.kind !== "add") oldLine += 1
        if (operation.kind !== "delete") newLine += 1
    }
    return records
}

function hunkRanges(
    records: readonly IDiffRecord[],
    contextLines: number,
): readonly IHunkRange[] {
    const ranges: IHunkRange[] = []
    for (let index = 0; index < records.length; index += 1) {
        if (records[index]?.kind === "equal") continue
        const start = Math.max(0, index - contextLines)
        const end = Math.min(records.length, index + contextLines + 1)
        const previous = ranges[ranges.length - 1]
        if (previous && start <= previous.end) previous.end = Math.max(previous.end, end)
        else ranges.push({ start, end })
    }
    return ranges
}

function displayDiffPath(prefix: "a" | "b", path: string | null): string {
    if (path === null) return "/dev/null"
    const value = `${prefix}/${path}`
    return /[\t\r\n"\\]/.test(value) ? JSON.stringify(value) : value
}
