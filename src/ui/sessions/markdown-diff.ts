import { parsePatch } from "diff"

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/
const NO_NEWLINE_MARKER = "\\ No newline at end of file"

/** Returns one validated diff, repairing only hunk counts for display. */
export function normalizeMarkdownDiff(diff: string): string | undefined {
    if (isRenderableDiff(diff)) return diff

    const repaired = repairHunkCounts(diff)
    return repaired && repaired !== diff && isRenderableDiff(repaired)
        ? repaired
        : undefined
}

function isRenderableDiff(diff: string): boolean {
    if (!/^--- .+\r?$/m.test(diff) || !/^\+\+\+ .+\r?$/m.test(diff)) {
        return false
    }

    try {
        const patches = parsePatch(diff)
        const patch = patches[0]
        return patch?.oldFileName !== undefined
            && patch.newFileName !== undefined
            && patch.hunks.length > 0
    } catch {
        return false
    }
}

function repairHunkCounts(diff: string): string | undefined {
    const lines = diff.replace(/\r\n?/g, "\n").split("\n")
    let foundHunk = false

    for (let index = 0; index < lines.length; index += 1) {
        const match = HUNK_HEADER.exec(lines[index] ?? "")
        if (!match) continue

        const oldStart = Number(match[1])
        const newStart = Number(match[2])
        if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)) {
            return undefined
        }

        foundHunk = true
        let oldLines = 0
        let newLines = 0
        let hasChange = false
        let canMarkNoNewline = false
        let bodyIndex = index + 1

        for (; bodyIndex < lines.length; bodyIndex += 1) {
            const line = lines[bodyIndex] ?? ""
            if (
                isDiffBoundary(lines, bodyIndex)
                || (
                    line === ""
                    && (
                        bodyIndex === lines.length - 1
                        || isDiffBoundary(lines, bodyIndex + 1)
                    )
                )
            ) break

            if (line === NO_NEWLINE_MARKER) {
                if (!canMarkNoNewline) return undefined
                canMarkNoNewline = false
                continue
            }

            switch (line[0]) {
                case " ":
                    oldLines += 1
                    newLines += 1
                    break
                case "-":
                    oldLines += 1
                    hasChange = true
                    break
                case "+":
                    newLines += 1
                    hasChange = true
                    break
                default:
                    return undefined
            }
            canMarkNoNewline = true
        }

        if (!hasChange) return undefined
        lines[index] = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${match[3] ?? ""}`
        index = bodyIndex - 1
    }

    return foundHunk ? lines.join("\n") : undefined
}

function isDiffBoundary(lines: readonly string[], index: number): boolean {
    const line = lines[index] ?? ""
    if (
        /^@@ /.test(line)
        || /^diff --git /.test(line)
        || /^Index:\s/.test(line)
        || /^diff(?: -r \w+)+\s/.test(line)
    ) return true

    return /^---\s/.test(line)
        && /^\+\+\+\s/.test(lines[index + 1] ?? "")
        && (
            /^@@\s/.test(lines[index + 2] ?? "")
            || index + 2 >= lines.length
        )
}
