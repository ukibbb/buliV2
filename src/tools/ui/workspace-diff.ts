interface IDiffLine {
    readonly content: string
    readonly raw: string
}

interface IDiffPath {
    readonly display: string
    readonly path: string | null
}

interface IHunkCounts {
    readonly oldStart: number
    readonly oldLines: number
    readonly newStart: number
    readonly newLines: number
}

export interface IWorkspaceDiffSection {
    readonly diff: string
    readonly label: string
    readonly hasHunks: boolean
    readonly hasNoNewlineMetadata: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/

/** Splits the exact workspace diff without treating hunk content as file headers. */
export function splitWorkspaceDiff(
    diff: string,
): readonly IWorkspaceDiffSection[] {
    const lines = splitLines(diff)
    if (lines.length === 0) return []

    const sections: IWorkspaceDiffSection[] = []
    let index = 0
    while (index < lines.length) {
        const start = index
        const oldPath = parseDiffPath(lines[index]?.content, "old")
        const newPath = parseDiffPath(lines[index + 1]?.content, "new")
        if (!oldPath || !newPath || (oldPath.path === null && newPath.path === null)) {
            return []
        }
        index += 2

        let hasHunks = false
        let hasNoNewlineMetadata = false
        let oldEndedWithoutNewline = false
        let newEndedWithoutNewline = false
        let previousOldEnd = 0
        let previousNewEnd = 0
        while (index < lines.length) {
            if (isFileHeaderPair(lines, index)) break

            const counts = parseHunkCounts(lines[index]?.content)
            if (!counts) return []
            if (
                (counts.oldLines === 0 && counts.newLines === 0)
                || (counts.oldLines > 0 && counts.oldStart === 0)
                || (counts.newLines > 0 && counts.newStart === 0)
                || (
                    hasHunks
                    && (
                        counts.oldStart < previousOldEnd
                        || counts.newStart < previousNewEnd
                    )
                )
                || (
                    oldPath.path === null
                    && (counts.oldStart !== 0 || counts.oldLines !== 0)
                )
                || (
                    newPath.path === null
                    && (counts.newStart !== 0 || counts.newLines !== 0)
                )
            ) return []
            hasHunks = true
            previousOldEnd = counts.oldStart + counts.oldLines
            previousNewEnd = counts.newStart + counts.newLines
            index += 1

            let oldLines = counts.oldLines
            let newLines = counts.newLines
            let canMarkNoNewline = false
            let lastBodyPrefix: string | undefined
            let hunkHasChange = false
            while (index < lines.length) {
                const content = lines[index]?.content ?? ""
                if (content === "\\ No newline at end of file") {
                    if (!canMarkNoNewline || !lastBodyPrefix) return []
                    if (lastBodyPrefix === " " || lastBodyPrefix === "-") {
                        oldEndedWithoutNewline = true
                    }
                    if (lastBodyPrefix === " " || lastBodyPrefix === "+") {
                        newEndedWithoutNewline = true
                    }
                    hasNoNewlineMetadata = true
                    canMarkNoNewline = false
                    lastBodyPrefix = undefined
                    index += 1
                    continue
                }
                if (oldLines === 0 && newLines === 0) break

                const prefix = content[0]
                if (prefix === " ") {
                    if (
                        oldLines === 0
                        || newLines === 0
                        || oldEndedWithoutNewline
                        || newEndedWithoutNewline
                    ) return []
                    oldLines -= 1
                    newLines -= 1
                } else if (prefix === "-") {
                    if (oldLines === 0 || oldEndedWithoutNewline) return []
                    oldLines -= 1
                    hunkHasChange = true
                } else if (prefix === "+") {
                    if (newLines === 0 || newEndedWithoutNewline) return []
                    newLines -= 1
                    hunkHasChange = true
                } else {
                    return []
                }
                canMarkNoNewline = true
                lastBodyPrefix = prefix
                index += 1
            }
            if (oldLines !== 0 || newLines !== 0 || !hunkHasChange) return []
        }

        const sectionDiff = lines.slice(start, index)
            .map((line) => line.raw)
            .join("")
        sections.push({
            diff: sectionDiff,
            label: diffLabel(oldPath, newPath),
            hasHunks,
            hasNoNewlineMetadata,
        })
    }

    return sections.map((section) => section.diff).join("") === diff
        ? sections
        : []
}

function splitLines(value: string): readonly IDiffLine[] {
    const lines: IDiffLine[] = []
    let start = 0
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== "\n") continue
        const raw = value.slice(start, index + 1)
        const withoutNewline = raw.slice(0, -1)
        lines.push({
            content: withoutNewline.endsWith("\r")
                ? withoutNewline.slice(0, -1)
                : withoutNewline,
            raw,
        })
        start = index + 1
    }
    if (start < value.length) {
        const raw = value.slice(start)
        lines.push({ content: raw, raw })
    }
    return lines
}

function isFileHeaderPair(
    lines: readonly IDiffLine[],
    index: number,
): boolean {
    return parseDiffPath(lines[index]?.content, "old") !== undefined
        && parseDiffPath(lines[index + 1]?.content, "new") !== undefined
}

function parseDiffPath(
    line: string | undefined,
    side: "old" | "new",
): IDiffPath | undefined {
    const marker = side === "old" ? "--- " : "+++ "
    const prefix = side === "old" ? "a/" : "b/"
    if (!line?.startsWith(marker)) return undefined

    const display = line.slice(marker.length)
    if (display === "/dev/null") return { display, path: null }

    let decoded = display
    if (display.startsWith('"')) {
        try {
            const value: unknown = JSON.parse(display)
            if (typeof value !== "string") return undefined
            decoded = value
        } catch {
            return undefined
        }
    }
    if (!decoded.startsWith(prefix)) return undefined
    const path = decoded.slice(prefix.length)
    if (
        !path
        || path.split("/").some(
            (part) => part.length === 0 || part === "." || part === "..",
        )
    ) return undefined
    return { display, path }
}

function parseHunkCounts(line: string | undefined): IHunkCounts | undefined {
    if (!line) return undefined
    const match = HUNK_HEADER.exec(line)
    if (!match) return undefined
    const oldStart = Number(match[1])
    const oldLines = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newLines = match[4] === undefined ? 1 : Number(match[4])
    if (
        !Number.isSafeInteger(oldStart)
        || !Number.isSafeInteger(oldLines)
        || !Number.isSafeInteger(newStart)
        || !Number.isSafeInteger(newLines)
    ) {
        return undefined
    }
    return {
        oldStart,
        oldLines,
        newStart,
        newLines,
    }
}

function diffLabel(oldPath: IDiffPath, newPath: IDiffPath): string {
    if (oldPath.path === null) return `Added ${newPath.path ?? newPath.display}`
    if (newPath.path === null) return `Deleted ${oldPath.path}`
    return oldPath.path === newPath.path
        ? oldPath.path
        : `${oldPath.path} -> ${newPath.path}`
}
