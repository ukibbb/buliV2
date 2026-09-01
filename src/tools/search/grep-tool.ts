import { spawn } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { Type } from "typebox"

import type { IAgentTool, IAgentToolResult } from "@/agent"
import { resolveToCwd } from "@/tools/shared/path-utils"
import {
    DEFAULT_MAX_BYTES,
    formatSize,
    GREP_MAX_LINE_LENGTH,
    truncateHead,
    truncateLine,
} from "@/tools/shared/truncation"

// Ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86 (c) 2025 Mario Zechner, MIT License.
const GREP_INPUT_SCHEMA = Type.Object({
    pattern: Type.String({
        description: "Search pattern (regex or literal string)",
    }),
    path: Type.Optional(Type.String({
        description: "Directory or file to search (default: current directory)",
    })),
    glob: Type.Optional(Type.String({
        description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
    })),
    ignoreCase: Type.Optional(Type.Boolean({
        description: "Case-insensitive search (default: false)",
    })),
    literal: Type.Optional(Type.Boolean({
        description: "Treat pattern as literal string instead of regex (default: false)",
    })),
    context: Type.Optional(Type.Number({
        description: "Number of lines to show before and after each match (default: 0)",
    })),
    limit: Type.Optional(Type.Number({
        description: "Maximum number of matches to return (default: 100)",
    })),
})

const DEFAULT_LIMIT = 100

interface IGrepMatch {
    readonly filePath: string
    readonly lineNumber: number
    readonly lineText?: string
}

/** Creates the Pi-style ripgrep-backed content searcher. */
export function createGrepTool(
    workspaceRoot: string,
    executable = "rg",
): IAgentTool<typeof GREP_INPUT_SCHEMA> {
    return {
        name: "grep",
        description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
        inputSchema: GREP_INPUT_SCHEMA,
        selfTruncatesOutput: true,
        execute: (input, context) => new Promise<IAgentToolResult>((resolve, reject) => {
            const signal = context.signal
            if (signal.aborted) {
                reject(new Error("Operation aborted"))
                return
            }

            let settled = false
            const settle = (fn: () => void): void => {
                if (settled) return
                settled = true
                fn()
            }

            const run = async (): Promise<void> => {
                try {
                    const searchPath = resolveToCwd(
                        input.path || ".",
                        workspaceRoot,
                    )
                    let isDirectory: boolean
                    try {
                        isDirectory = (await stat(searchPath)).isDirectory()
                    } catch {
                        settle(() => reject(
                            new Error(`Path not found: ${searchPath}`),
                        ))
                        return
                    }

                    if (signal.aborted) {
                        settle(() => reject(new Error("Operation aborted")))
                        return
                    }

                    const contextValue = input.context && input.context > 0
                        ? input.context
                        : 0
                    const effectiveLimit = Math.max(
                        1,
                        input.limit ?? DEFAULT_LIMIT,
                    )
                    const formatPath = (filePath: string): string => {
                        if (isDirectory) {
                            const relative = path.relative(searchPath, filePath)
                            if (relative && !relative.startsWith("..")) {
                                return relative.replace(/\\/g, "/")
                            }
                        }
                        return path.basename(filePath)
                    }

                    const fileCache = new Map<string, string[]>()
                    const getFileLines = async (
                        filePath: string,
                    ): Promise<string[]> => {
                        let lines = fileCache.get(filePath)
                        if (!lines) {
                            try {
                                const content = await readFile(filePath, "utf-8")
                                lines = content
                                    .replace(/\r\n/g, "\n")
                                    .replace(/\r/g, "\n")
                                    .split("\n")
                            } catch {
                                lines = []
                            }
                            fileCache.set(filePath, lines)
                        }
                        return lines
                    }

                    const args: string[] = [
                        "--json",
                        "--line-number",
                        "--color=never",
                        "--hidden",
                    ]
                    if (input.ignoreCase) args.push("--ignore-case")
                    if (input.literal) args.push("--fixed-strings")
                    if (input.glob) args.push("--glob", input.glob)
                    args.push("--", input.pattern, searchPath)

                    const child = spawn(executable, args, {
                        stdio: ["ignore", "pipe", "pipe"],
                    })
                    const outputReader = createInterface({ input: child.stdout })
                    let stderr = ""
                    let matchCount = 0
                    let matchLimitReached = false
                    let linesTruncated = false
                    let aborted = false
                    let killedDueToLimit = false
                    const outputLines: string[] = []

                    const cleanup = (): void => {
                        outputReader.close()
                        signal.removeEventListener("abort", onAbort)
                    }
                    const stopChild = (dueToLimit = false): void => {
                        if (!child.killed) {
                            killedDueToLimit = dueToLimit
                            child.kill()
                        }
                    }
                    const onAbort = (): void => {
                        aborted = true
                        stopChild()
                    }
                    signal.addEventListener("abort", onAbort, { once: true })
                    if (signal.aborted) onAbort()

                    child.stderr.on("data", (chunk) => {
                        stderr += chunk.toString()
                    })

                    const formatBlock = async (
                        filePath: string,
                        lineNumber: number,
                    ): Promise<string[]> => {
                        const relativePath = formatPath(filePath)
                        const lines = await getFileLines(filePath)
                        if (!lines.length) {
                            return [
                                `${relativePath}:${lineNumber}: (unable to read file)`,
                            ]
                        }

                        const block: string[] = []
                        const start = contextValue > 0
                            ? Math.max(1, lineNumber - contextValue)
                            : lineNumber
                        const end = contextValue > 0
                            ? Math.min(lines.length, lineNumber + contextValue)
                            : lineNumber
                        for (let current = start; current <= end; current += 1) {
                            const lineText = lines[current - 1] ?? ""
                            const sanitized = lineText.replace(/\r/g, "")
                            const isMatchLine = current === lineNumber
                            const truncated = truncateLine(sanitized)
                            if (truncated.wasTruncated) linesTruncated = true
                            if (isMatchLine) {
                                block.push(
                                    `${relativePath}:${current}: ${truncated.text}`,
                                )
                            } else {
                                block.push(
                                    `${relativePath}-${current}- ${truncated.text}`,
                                )
                            }
                        }
                        return block
                    }

                    const matches: IGrepMatch[] = []
                    outputReader.on("line", (line) => {
                        if (!line.trim() || matchCount >= effectiveLimit) return

                        let event: any
                        try {
                            event = JSON.parse(line)
                        } catch {
                            return
                        }
                        if (event.type !== "match") return

                        matchCount += 1
                        const filePath = event.data?.path?.text
                        const lineNumber = event.data?.line_number
                        const lineText = event.data?.lines?.text
                        if (filePath && typeof lineNumber === "number") {
                            matches.push({ filePath, lineNumber, lineText })
                        }
                        if (matchCount >= effectiveLimit) {
                            matchLimitReached = true
                            stopChild(true)
                        }
                    })

                    child.on("error", (error) => {
                        cleanup()
                        settle(() => reject(
                            new Error(`Failed to run ripgrep: ${error.message}`),
                        ))
                    })

                    child.on("close", async (code) => {
                        cleanup()
                        if (aborted) {
                            settle(() => reject(new Error("Operation aborted")))
                            return
                        }
                        if (
                            !killedDueToLimit
                            && code !== 0
                            && code !== 1
                        ) {
                            const errorMessage = stderr.trim()
                                || `ripgrep exited with code ${code}`
                            settle(() => reject(new Error(errorMessage)))
                            return
                        }
                        if (matchCount === 0) {
                            settle(() => resolve({
                                content: "No matches found",
                                summary: "0 matches",
                            }))
                            return
                        }

                        for (const match of matches) {
                            if (
                                contextValue === 0
                                && match.lineText !== undefined
                            ) {
                                const relativePath = formatPath(match.filePath)
                                const sanitized = match.lineText
                                    .replace(/\r\n/g, "\n")
                                    .replace(/\r/g, "")
                                    .replace(/\n$/, "")
                                const truncated = truncateLine(sanitized)
                                if (truncated.wasTruncated) {
                                    linesTruncated = true
                                }
                                outputLines.push(
                                    `${relativePath}:${match.lineNumber}: ${truncated.text}`,
                                )
                            } else {
                                const block = await formatBlock(
                                    match.filePath,
                                    match.lineNumber,
                                )
                                outputLines.push(...block)
                            }
                        }

                        const rawOutput = outputLines.join("\n")
                        const truncation = truncateHead(rawOutput, {
                            maxLines: Number.MAX_SAFE_INTEGER,
                        })
                        let output = truncation.content
                        const notices: string[] = []
                        if (matchLimitReached) {
                            notices.push(
                                `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
                            )
                        }
                        if (truncation.truncated) {
                            notices.push(
                                `${formatSize(DEFAULT_MAX_BYTES)} limit reached`,
                            )
                        }
                        if (linesTruncated) {
                            notices.push(
                                `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
                            )
                        }
                        if (notices.length > 0) {
                            output += `\n\n[${notices.join(". ")}]`
                        }
                        const summary = `${matchCount} ${matchCount === 1 ? "match" : "matches"}${matchLimitReached ? ", limit reached" : ""}`
                        settle(() => resolve({ content: output, summary }))
                    })
                } catch (error) {
                    settle(() => reject(error))
                }
            }

            void run()
        }),
    }
}
