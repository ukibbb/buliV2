import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import { Type } from "typebox"

import { defineAgentTool, type IAgentTool } from "@/agent/tool"
import type { IAgentToolDeclaration } from "@/agent/definition"
import { resolveReadPath } from "@/agent/tools/shared/path-utils"
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    truncateHead,
} from "@/agent/tools/shared/truncation"

// Ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86 (c) 2025 Mario Zechner, MIT License.
const READ_INPUT_SCHEMA = Type.Object({
    path: Type.String({
        description: "Path to the file to read (relative or absolute)",
    }),
    offset: Type.Optional(Type.Number({
        description: "Line number to start reading from (1-indexed)",
    })),
    limit: Type.Optional(Type.Number({
        description: "Maximum number of lines to read",
    })),
})

export const ReadTool: IAgentToolDeclaration<{
    readonly workspaceRoot: string
}> = {
    name: "read",
    instructions: [
        "### Text reading",
        "- Use read instead of cat, head, tail, or sed to read text files.",
        "- read returns plain text without line numbers. For large files, continue using offset and limit.",
    ],
    create: ({ workspaceRoot }) => createReadTool(workspaceRoot),
}

/** Creates the text-only Pi-style file reader. */
export function createReadTool(
    workspaceRoot: string,
): IAgentTool<typeof READ_INPUT_SCHEMA, "read"> {
    return defineAgentTool({
        name: "read",
        description: `Read the contents of a text file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
        inputSchema: READ_INPUT_SCHEMA,
        selfTruncatesOutput: true,
        execute: (input, context) => new Promise<string>((resolve, reject) => {
            const signal = context.signal
            if (signal.aborted) {
                reject(new Error("Operation aborted"))
                return
            }

            let aborted = false
            const onAbort = (): void => {
                aborted = true
                reject(new Error("Operation aborted"))
            }
            signal.addEventListener("abort", onAbort, { once: true })

            const run = async (): Promise<void> => {
                try {
                    const absolutePath = await resolveReadPath(input.path, workspaceRoot)
                    if (aborted) return

                    const buffer = await readFile(absolutePath)
                    const textContent = buffer.toString("utf-8")
                    const allLines = textContent.split("\n")
                    const totalFileLines = allLines.length
                    const startLine = input.offset
                        ? Math.max(0, input.offset - 1)
                        : 0
                    const startLineDisplay = startLine + 1

                    if (startLine >= allLines.length) {
                        throw new Error(
                            `Offset ${input.offset} is beyond end of file (${allLines.length} lines total)`,
                        )
                    }

                    let selectedContent: string
                    let userLimitedLines: number | undefined
                    if (input.limit !== undefined) {
                        const endLine = Math.min(
                            startLine + input.limit,
                            allLines.length,
                        )
                        selectedContent = allLines.slice(startLine, endLine).join("\n")
                        userLimitedLines = endLine - startLine
                    } else {
                        selectedContent = allLines.slice(startLine).join("\n")
                    }

                    const truncation = truncateHead(selectedContent)
                    let outputText: string
                    if (truncation.firstLineExceedsLimit) {
                        const firstLineSize = formatSize(Buffer.byteLength(
                            allLines[startLine]!,
                            "utf-8",
                        ))
                        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${input.path} | head -c ${DEFAULT_MAX_BYTES}]`
                    } else if (truncation.truncated) {
                        const endLineDisplay = startLineDisplay
                            + truncation.outputLines
                            - 1
                        const nextOffset = endLineDisplay + 1
                        outputText = truncation.content
                        if (truncation.truncatedBy === "lines") {
                            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
                        } else {
                            outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
                        }
                    } else if (
                        userLimitedLines !== undefined
                        && startLine + userLimitedLines < allLines.length
                    ) {
                        const remaining = allLines.length
                            - (startLine + userLimitedLines)
                        const nextOffset = startLine + userLimitedLines + 1
                        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
                    } else {
                        outputText = truncation.content
                    }

                    if (aborted) return
                    signal.removeEventListener("abort", onAbort)
                    resolve(outputText)
                } catch (error) {
                    signal.removeEventListener("abort", onAbort)
                    if (!aborted) reject(error)
                }
            }

            void run()
        }),
    })
}
