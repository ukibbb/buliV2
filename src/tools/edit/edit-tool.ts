import { constants } from "node:fs"
import {
    access,
    readFile,
    writeFile,
} from "node:fs/promises"
import { createTwoFilesPatch } from "diff"
import { Type, type Static } from "typebox"

import type { IAgentTool } from "@/agent"
import {
    withFileMutationQueue,
} from "@/tools/shared/file-mutation"
import type { FileChangeProposalStore } from "@/tools/patch/file-change-proposal-store"
import { resolveToCwd } from "@/tools/shared/path-utils"

// Ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86 (c) 2025 Mario Zechner, MIT License.
const REPLACE_EDIT_SCHEMA = Type.Object(
    {
        oldText: Type.String({
            description:
                "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
        }),
        newText: Type.String({
            description: "Replacement text for this targeted edit.",
        }),
    },
    {},
)

const EDIT_INPUT_SCHEMA = Type.Object(
    {
        path: Type.String({
            description: "Path to the file to edit (relative or absolute)",
        }),
        edits: Type.Array(REPLACE_EDIT_SCHEMA, {
            description:
                "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
        }),
    },
    {},
)

export type EditToolInput = Static<typeof EDIT_INPUT_SCHEMA>

type TLegacyEditToolInput = EditToolInput & {
    oldText?: unknown
    newText?: unknown
}

interface ITextEdit {
    readonly oldText: string
    readonly newText: string
}

interface ISingleEditInput {
    readonly oldText: string
    readonly newText: string
}

interface ILineSpan {
    readonly start: number
    readonly end: number
}

interface IMatchedEdit {
    readonly editIndex: number
    readonly matchIndex: number
    readonly matchLength: number
    readonly newText: string
}

type TTextReplacement = Pick<
    IMatchedEdit,
    "matchIndex" | "matchLength" | "newText"
>

interface IFuzzyMatchResult {
    readonly found: boolean
    readonly index: number
    readonly matchLength: number
    readonly usedFuzzyMatch: boolean
}

/** Normalizes common model argument variants before schema validation. */
export function prepareEditArguments(input: unknown): EditToolInput {
    if (!input || typeof input !== "object") return input as EditToolInput

    const args = input as Record<string, unknown>
    if (typeof args.edits === "string") {
        try {
            const parsed: unknown = JSON.parse(args.edits)
            if (Array.isArray(parsed)) {
                args.edits = parsed
            } else if (isSingleEditInput(parsed)) {
                args.edits = [parsed]
            }
        } catch {}
    } else if (isSingleEditInput(args.edits)) {
        args.edits = [args.edits]
    }

    const legacy = args as TLegacyEditToolInput
    if (
        typeof legacy.oldText !== "string"
        || typeof legacy.newText !== "string"
    ) return args as EditToolInput

    const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : []
    edits.push({ oldText: legacy.oldText, newText: legacy.newText })
    const { oldText: _oldText, newText: _newText, ...rest } = legacy
    return { ...rest, edits } as EditToolInput
}

/** Creates Pi's direct, exact-text edit tool for one working directory. */
export function createEditTool(
    cwd: string,
    proposalStore?: FileChangeProposalStore,
): IAgentTool<typeof EDIT_INPUT_SCHEMA> {
    return {
        name: "edit",
        description: proposalStore
            ? "Prepare an immutable proposal to edit one file using exact text replacement. This does not modify the file. Every edits[].oldText must match a unique, non-overlapping region of the original file."
            : "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
        inputSchema: EDIT_INPUT_SCHEMA,
        prepareArguments: prepareEditArguments,
        execute: async (input, context) => {
            const { path, edits } = validateEditInput(input)
            const absolutePath = resolveToCwd(path, cwd)

            return await withFileMutationQueue(absolutePath, async () => {
                const throwIfAborted = (): void => {
                    if (context.signal.aborted) {
                        throw new Error("Operation aborted")
                    }
                }

                throwIfAborted()
                try {
                    await access(
                        absolutePath,
                        constants.R_OK | constants.W_OK,
                    )
                } catch (error) {
                    throwIfAborted()
                    const message = error instanceof Error && "code" in error
                        ? `Error code: ${error.code}`
                        : String(error)
                    throw new Error(`Could not edit file: ${path}. ${message}.`)
                }
                throwIfAborted()

                const buffer = await readFile(absolutePath)
                const rawContent = buffer.toString("utf-8")
                throwIfAborted()

                const { bom, text: content } = splitBom(rawContent)
                const originalEnding = detectLineEnding(content)
                const normalizedContent = normalizeToLF(content)
                const { newContent } = applyEditsToNormalizedContent(
                    normalizedContent,
                    edits,
                    path,
                )
                throwIfAborted()

                const finalContent = bom
                    + restoreLineEndings(newContent, originalEnding)
                if (proposalStore) {
                    const proposal = proposalStore.propose({
                        sessionId: context.sessionId,
                        runId: context.runId,
                        toolCallId: context.toolCallId,
                        operation: "edit",
                        path,
                        baseContent: rawContent,
                        targetContent: finalContent,
                        diff: createTwoFilesPatch(
                            `a/${path}`,
                            `b/${path}`,
                            rawContent,
                            finalContent,
                            "",
                            "",
                        ),
                    })
                    return `Proposed ${edits.length} replacement(s) in ${path}. Proposal ID: ${proposal.id}. Wait for the user's next message before applying or rejecting it.`
                }

                await writeFile(absolutePath, finalContent, "utf-8")
                throwIfAborted()

                return `Successfully replaced ${edits.length} block(s) in ${path}.`
            })
        },
    }
}

function validateEditInput(
    input: EditToolInput,
): { path: string; edits: ITextEdit[] } {
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error(
            "Edit tool input is invalid. edits must contain at least one replacement.",
        )
    }
    return { path: input.path, edits: input.edits }
}

function isSingleEditInput(value: unknown): value is ISingleEditInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false
    }
    const edit = value as Record<string, unknown>
    return typeof edit.oldText === "string"
        && typeof edit.newText === "string"
}

function splitBom(content: string): { bom: string; text: string } {
    return content.startsWith("\uFEFF")
        ? { bom: "\uFEFF", text: content.slice(1) }
        : { bom: "", text: content }
}

function detectLineEnding(content: string): "\r\n" | "\n" {
    const crlfIndex = content.indexOf("\r\n")
    const lfIndex = content.indexOf("\n")
    if (lfIndex === -1 || crlfIndex === -1) return "\n"
    return crlfIndex < lfIndex ? "\r\n" : "\n"
}

function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
    return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}

function normalizeForFuzzyMatch(text: string): string {
    return text
        .normalize("NFKC")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
}

function fuzzyFindText(content: string, oldText: string): IFuzzyMatchResult {
    const exactIndex = content.indexOf(oldText)
    if (exactIndex !== -1) {
        return {
            found: true,
            index: exactIndex,
            matchLength: oldText.length,
            usedFuzzyMatch: false,
        }
    }

    const fuzzyContent = normalizeForFuzzyMatch(content)
    const fuzzyOldText = normalizeForFuzzyMatch(oldText)
    const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText)
    if (fuzzyIndex === -1) {
        return {
            found: false,
            index: -1,
            matchLength: 0,
            usedFuzzyMatch: false,
        }
    }
    return {
        found: true,
        index: fuzzyIndex,
        matchLength: fuzzyOldText.length,
        usedFuzzyMatch: true,
    }
}

function countOccurrences(content: string, oldText: string): number {
    const fuzzyContent = normalizeForFuzzyMatch(content)
    const fuzzyOldText = normalizeForFuzzyMatch(oldText)
    return fuzzyContent.split(fuzzyOldText).length - 1
}

function applyEditsToNormalizedContent(
    normalizedContent: string,
    edits: readonly ITextEdit[],
    path: string,
): { baseContent: string; newContent: string } {
    const normalizedEdits = edits.map((edit) => ({
        oldText: normalizeToLF(edit.oldText),
        newText: normalizeToLF(edit.newText),
    }))

    for (const [index, edit] of normalizedEdits.entries()) {
        if (edit.oldText.length === 0) {
            throw emptyOldTextError(path, index, normalizedEdits.length)
        }
    }

    const initialMatches = normalizedEdits.map((edit) => (
        fuzzyFindText(normalizedContent, edit.oldText)
    ))
    const usedFuzzyMatch = initialMatches.some((match) => (
        match.usedFuzzyMatch
    ))
    const replacementBaseContent = usedFuzzyMatch
        ? normalizeForFuzzyMatch(normalizedContent)
        : normalizedContent

    const matchedEdits: IMatchedEdit[] = []
    for (const [index, edit] of normalizedEdits.entries()) {
        const match = fuzzyFindText(replacementBaseContent, edit.oldText)
        if (!match.found) {
            throw notFoundError(path, index, normalizedEdits.length)
        }

        const occurrences = countOccurrences(
            replacementBaseContent,
            edit.oldText,
        )
        if (occurrences > 1) {
            throw duplicateError(
                path,
                index,
                normalizedEdits.length,
                occurrences,
            )
        }

        matchedEdits.push({
            editIndex: index,
            matchIndex: match.index,
            matchLength: match.matchLength,
            newText: edit.newText,
        })
    }

    matchedEdits.sort((left, right) => left.matchIndex - right.matchIndex)
    for (let index = 1; index < matchedEdits.length; index += 1) {
        const previous = matchedEdits[index - 1]
        const current = matchedEdits[index]
        if (!previous || !current) continue
        if (previous.matchIndex + previous.matchLength > current.matchIndex) {
            throw new Error(
                `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
            )
        }
    }

    const baseContent = normalizedContent
    const newContent = usedFuzzyMatch
        ? applyReplacementsPreservingUnchangedLines(
            normalizedContent,
            replacementBaseContent,
            matchedEdits,
        )
        : applyReplacements(replacementBaseContent, matchedEdits)

    if (baseContent === newContent) {
        throw noChangeError(path, normalizedEdits.length)
    }
    return { baseContent, newContent }
}

function applyReplacementsPreservingUnchangedLines(
    originalContent: string,
    baseContent: string,
    replacements: readonly TTextReplacement[],
): string {
    const originalLines = splitLinesWithEndings(originalContent)
    const baseLines = lineSpans(baseContent)
    if (originalLines.length !== baseLines.length) {
        throw new Error(
            "Cannot preserve unchanged lines because the base content has a different line count.",
        )
    }

    const groups: Array<{
        startLine: number
        endLine: number
        replacements: TTextReplacement[]
    }> = []
    const sorted = [...replacements].sort((left, right) => (
        left.matchIndex - right.matchIndex
    ))
    for (const replacement of sorted) {
        const range = replacementLineRange(baseLines, replacement)
        const current = groups.at(-1)
        if (current && range.startLine < current.endLine) {
            current.endLine = Math.max(current.endLine, range.endLine)
            current.replacements.push(replacement)
        } else {
            groups.push({ ...range, replacements: [replacement] })
        }
    }

    let originalLineIndex = 0
    let result = ""
    for (const group of groups) {
        result += originalLines
            .slice(originalLineIndex, group.startLine)
            .join("")

        const firstLine = baseLines[group.startLine]
        const lastLine = baseLines[group.endLine - 1]
        if (!firstLine || !lastLine) {
            throw new Error("Replacement range is outside the base content.")
        }
        result += applyReplacements(
            baseContent.slice(firstLine.start, lastLine.end),
            group.replacements,
            firstLine.start,
        )
        originalLineIndex = group.endLine
    }
    result += originalLines.slice(originalLineIndex).join("")
    return result
}

function applyReplacements(
    content: string,
    replacements: readonly TTextReplacement[],
    offset = 0,
): string {
    let result = content
    for (let index = replacements.length - 1; index >= 0; index -= 1) {
        const replacement = replacements[index]
        if (!replacement) continue
        const matchIndex = replacement.matchIndex - offset
        result = result.substring(0, matchIndex)
            + replacement.newText
            + result.substring(matchIndex + replacement.matchLength)
    }
    return result
}

function splitLinesWithEndings(content: string): string[] {
    return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function lineSpans(content: string): ILineSpan[] {
    let offset = 0
    return splitLinesWithEndings(content).map((line) => {
        const span = { start: offset, end: offset + line.length }
        offset = span.end
        return span
    })
}

function replacementLineRange(
    lines: readonly ILineSpan[],
    replacement: TTextReplacement,
): { startLine: number; endLine: number } {
    const replacementStart = replacement.matchIndex
    const replacementEnd = replacement.matchIndex + replacement.matchLength
    let startLine = -1
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (
            line
            && replacementStart >= line.start
            && replacementStart < line.end
        ) {
            startLine = index
            break
        }
    }
    if (startLine === -1) {
        throw new Error("Replacement range is outside the base content.")
    }

    let endLine = startLine
    while (endLine < lines.length) {
        const line = lines[endLine]
        if (!line || line.end >= replacementEnd) break
        endLine += 1
    }
    if (endLine >= lines.length) {
        throw new Error("Replacement range is outside the base content.")
    }
    return { startLine, endLine: endLine + 1 }
}

function notFoundError(
    path: string,
    editIndex: number,
    totalEdits: number,
): Error {
    if (totalEdits === 1) {
        return new Error(
            `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
        )
    }
    return new Error(
        `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
    )
}

function duplicateError(
    path: string,
    editIndex: number,
    totalEdits: number,
    occurrences: number,
): Error {
    if (totalEdits === 1) {
        return new Error(
            `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
        )
    }
    return new Error(
        `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
    )
}

function emptyOldTextError(
    path: string,
    editIndex: number,
    totalEdits: number,
): Error {
    return totalEdits === 1
        ? new Error(`oldText must not be empty in ${path}.`)
        : new Error(
            `edits[${editIndex}].oldText must not be empty in ${path}.`,
        )
}

function noChangeError(path: string, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
        )
    }
    return new Error(
        `No changes made to ${path}. The replacements produced identical content.`,
    )
}
