import { Buffer } from "node:buffer"
import { createTwoFilesPatch } from "diff"

import type { IAgentToolResult } from "@/agent/tool"

const MAX_DIFF_INPUT_BYTES = 2_000_000
const MAX_DIFF_BYTES = 100_000
const MAX_DIFF_LINES = 2_000
const DIFF_TIMEOUT_MS = 100

interface IFileWriteResultInput {
    readonly path: string
    readonly before: string | undefined
    readonly after: string
    readonly content: string
    readonly signal: AbortSignal
}

/** Creates a bounded preview only after the caller has successfully written the file. */
export function createFileWriteResult(input: IFileWriteResultInput): IAgentToolResult {
    const preview = createDiffPreview(input)
    const cancelled = input.signal.aborted
    const summary = [
        cancelled ? "WARNING: File was written despite cancellation." : undefined,
        preview.summary,
    ].filter((value): value is string => value !== undefined).join(" ")

    return {
        content: input.content,
        outcome: cancelled ? "committed-after-abort" : "completed",
        ...(preview.diff === undefined ? {} : { diff: preview.diff }),
        ...(summary.length === 0 ? {} : { summary }),
    }
}

function createDiffPreview(
    input: IFileWriteResultInput,
): Pick<IAgentToolResult, "diff" | "summary"> {
    const before = input.before ?? ""
    if (before === input.after) {
        return input.before === undefined
            ? { summary: "Created an empty file; no text diff." }
            : {}
    }
    if (
        Buffer.byteLength(before, "utf8") + Buffer.byteLength(input.after, "utf8")
        > MAX_DIFF_INPUT_BYTES
    ) {
        return { summary: "Diff omitted: input exceeds 2 MB." }
    }

    try {
        const diff = createTwoFilesPatch(
            input.before === undefined ? "/dev/null" : `a/${input.path}`,
            `b/${input.path}`,
            before,
            input.after,
            "",
            "",
            { context: 3, timeout: DIFF_TIMEOUT_MS },
        )
        if (diff === undefined) {
            return { summary: "Diff omitted: computation limit exceeded." }
        }
        if (
            Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES
            || diff.trimEnd().split("\n").length > MAX_DIFF_LINES
        ) {
            return { summary: "Diff omitted: exceeds 100 KB or 2000 lines." }
        }
        return { diff }
    } catch {
        return { summary: "File was written, but the diff could not be generated." }
    }
}
