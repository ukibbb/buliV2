import { spawn } from "node:child_process"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { Type } from "typebox"

import type { IAgentTool, IAgentToolResult } from "@/agent"
import { pathExists, resolveToCwd } from "@/tools/shared/path-utils"
import {
    DEFAULT_MAX_BYTES,
    formatSize,
    truncateHead,
} from "@/tools/shared/truncation"

// Ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86 (c) 2025 Mario Zechner, MIT License.
const FIND_INPUT_SCHEMA = Type.Object({
    pattern: Type.String({
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    }),
    path: Type.Optional(Type.String({
        description: "Directory to search in (default: current directory)",
    })),
    limit: Type.Optional(Type.Number({
        description: "Maximum number of results (default: 1000)",
    })),
})

const DEFAULT_LIMIT = 1_000

/** Creates the Pi-style fd-backed file finder. */
export function createFindTool(
    workspaceRoot: string,
    executable = "fd",
): IAgentTool<typeof FIND_INPUT_SCHEMA> {
    return {
        name: "find",
        description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
        inputSchema: FIND_INPUT_SCHEMA,
        selfTruncatesOutput: true,
        execute: (input, context) => new Promise<IAgentToolResult>((resolve, reject) => {
            const signal = context.signal
            if (signal.aborted) {
                reject(new Error("Operation aborted"))
                return
            }

            let settled = false
            let stopChild: (() => void) | undefined
            const settle = (fn: () => void): void => {
                if (settled) return
                settled = true
                signal.removeEventListener("abort", onAbort)
                stopChild = undefined
                fn()
            }
            const onAbort = (): void => {
                stopChild?.()
                settle(() => reject(new Error("Operation aborted")))
            }
            signal.addEventListener("abort", onAbort, { once: true })

            const run = async (): Promise<void> => {
                try {
                    const searchPath = resolveToCwd(
                        input.path || ".",
                        workspaceRoot,
                    )
                    const effectiveLimit = input.limit ?? DEFAULT_LIMIT
                    const args: string[] = [
                        "--glob",
                        "--color=never",
                        "--hidden",
                    ]

                    let insideGitRepo = false
                    for (let current = searchPath; ; ) {
                        if (await pathExists(path.join(current, ".git"))) {
                            insideGitRepo = true
                            break
                        }
                        const parent = path.dirname(current)
                        if (parent === current) break
                        current = parent
                    }
                    if (signal.aborted) return

                    if (!insideGitRepo) args.push("--no-require-git")
                    args.push("--max-results", String(effectiveLimit))

                    let effectivePattern = input.pattern
                    if (input.pattern.includes("/")) {
                        args.push("--full-path")
                        if (
                            !input.pattern.startsWith("/")
                            && !input.pattern.startsWith("**/")
                            && input.pattern !== "**"
                        ) {
                            effectivePattern = `**/${input.pattern}`
                        }
                        if (process.platform === "win32") {
                            effectivePattern = effectivePattern.replaceAll(
                                "/",
                                String.raw`[/\\]`,
                            )
                        }
                    }
                    args.push("--", effectivePattern, searchPath)

                    const child = spawn(executable, args, {
                        stdio: ["ignore", "pipe", "pipe"],
                    })
                    const outputReader = createInterface({ input: child.stdout })
                    let stderr = ""
                    const lines: string[] = []

                    stopChild = (): void => {
                        if (!child.killed) child.kill()
                    }

                    const cleanup = (): void => {
                        outputReader.close()
                    }

                    child.stderr.on("data", (chunk) => {
                        stderr += chunk.toString()
                    })

                    outputReader.on("line", (line) => {
                        lines.push(line)
                    })

                    child.on("error", (error) => {
                        cleanup()
                        settle(() => reject(
                            new Error(`Failed to run fd: ${error.message}`),
                        ))
                    })

                    child.on("close", (code) => {
                        cleanup()
                        if (signal.aborted) {
                            settle(() => reject(new Error("Operation aborted")))
                            return
                        }

                        const output = lines.join("\n")
                        if (code !== 0) {
                            const errorMessage = stderr.trim()
                                || `fd exited with code ${code}`
                            if (!output) {
                                settle(() => reject(new Error(errorMessage)))
                                return
                            }
                        }
                        if (!output) {
                            settle(() => resolve({
                                content: "No files found matching pattern",
                                summary: "0 files",
                            }))
                            return
                        }

                        const relativized: string[] = []
                        for (const rawLine of lines) {
                            const line = rawLine.replace(/\r$/, "").trim()
                            if (!line) continue
                            relativized.push(relativizeFindResultPath(
                                line,
                                searchPath,
                            ))
                        }

                        const resultLimitReached = relativized.length
                            >= effectiveLimit
                        const rawOutput = relativized.join("\n")
                        const truncation = truncateHead(rawOutput, {
                            maxLines: Number.MAX_SAFE_INTEGER,
                        })
                        let resultOutput = truncation.content
                        const notices: string[] = []
                        if (resultLimitReached) {
                            notices.push(
                                `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
                            )
                        }
                        if (truncation.truncated) {
                            notices.push(
                                `${formatSize(DEFAULT_MAX_BYTES)} limit reached`,
                            )
                        }
                        if (notices.length > 0) {
                            resultOutput += `\n\n[${notices.join(". ")}]`
                        }
                        const resultCount = relativized.length
                        const summary = `${resultCount} ${resultCount === 1 ? "file" : "files"}${resultLimitReached ? ", limit reached" : ""}`
                        settle(() => resolve({ content: resultOutput, summary }))
                    })
                } catch (error) {
                    if (signal.aborted) {
                        settle(() => reject(new Error("Operation aborted")))
                        return
                    }
                    const normalizedError = error instanceof Error
                        ? error
                        : new Error(String(error))
                    settle(() => reject(normalizedError))
                }
            }

            void run()
        }),
    }
}

function relativizeFindResultPath(
    resultPath: string,
    searchPath: string,
): string {
    const hadTrailingSeparator = resultPath.endsWith(path.sep)
        || (path.sep === "\\" && resultPath.endsWith("/"))
    const relativePath = path.isAbsolute(resultPath)
        ? path.relative(searchPath, resultPath)
        : resultPath
    const posixPath = relativePath.split(path.sep).join("/")
    return hadTrailingSeparator && !posixPath.endsWith("/")
        ? `${posixPath}/`
        : posixPath
}
