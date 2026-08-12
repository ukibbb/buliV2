import { realpath } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"

import type { IAgentTool } from "@/agent/agent-types"
import type { TJsonObject } from "@/domain"

const MAX_TOOL_OUTPUT_CHARACTERS = 100_000

export function createWorkspaceTools(
    workspaceRoot: string,
): readonly IAgentTool[] {
    const readFile: IAgentTool = {
        name: "read_file",
        description: "Read a UTF-8 file from the current workspace.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path relative to the current workspace",
                },
            },
            required: ["path"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            const path = requireString(input, "path")
            context.signal.throwIfAborted()
            const file = await realpath(resolve(workspaceRoot, path))

            if (!file.startsWith(`${workspaceRoot}${sep}`)) {
                throw new Error("Path is outside the current workspace")
            }

            const contents = await Bun.file(file).text()
            context.signal.throwIfAborted()
            return limitToolOutput(contents)
        },
    }

    const glob: IAgentTool = {
        name: "glob",
        description: "Find files in the current workspace using a glob pattern.",
        inputSchema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    description: "Relative glob pattern, for example **/*.ts",
                },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            const pattern = requireString(input, "pattern")
            context.signal.throwIfAborted()

            if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
                throw new Error("Glob pattern must stay inside the workspace")
            }

            const files: string[] = []

            for await (const file of new Bun.Glob(pattern).scan({
                cwd: workspaceRoot,
                onlyFiles: true,
                dot: false,
                followSymlinks: false,
            })) {
                context.signal.throwIfAborted()
                const segments = file.split(/[\\/]/)
                if (segments.includes(".git") || segments.includes("node_modules")) {
                    continue
                }

                files.push(file)
                if (files.length === 100) break
            }

            context.signal.throwIfAborted()
            return limitToolOutput(files.join("\n") || "No files found")
        },
    }

    const grep: IAgentTool = {
        name: "grep",
        description: "Search workspace file contents using a regular expression.",
        inputSchema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    minLength: 1,
                    description: "Regular expression to search for",
                },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            const pattern = requireString(input, "pattern")
            context.signal.throwIfAborted()
            if (!pattern) throw new Error("Search pattern cannot be empty")

            const searchProcess = Bun.spawn([
                "rg",
                "--no-config",
                "--line-number",
                "--no-heading",
                "--color=never",
                "--glob=!**/.git/**",
                "--glob=!**/node_modules/**",
                "--",
                pattern,
                ".",
            ], {
                cwd: workspaceRoot,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                signal: AbortSignal.any([
                    context.signal,
                    AbortSignal.timeout(10_000),
                ]),
            })

            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(searchProcess.stdout).text(),
                new Response(searchProcess.stderr).text(),
                searchProcess.exited,
            ])

            if (exitCode === 1) return "No matches found"
            if (exitCode !== 0) {
                throw new Error(
                    stderr.trim() || `ripgrep failed with exit code ${exitCode}`,
                )
            }

            const matches = stdout.trimEnd().split("\n")
            const visibleMatches = matches.slice(0, 100)

            if (matches.length > visibleMatches.length) {
                visibleMatches.push("... results truncated")
            }

            return limitToolOutput(visibleMatches.join("\n"))
        },
    }

    return [readFile, glob, grep]
}

function requireString(input: TJsonObject, key: string): string {
    const value = input[key]
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }

    return value
}

function limitToolOutput(output: string): string {
    if (output.length <= MAX_TOOL_OUTPUT_CHARACTERS) return output

    return [
        output.slice(0, MAX_TOOL_OUTPUT_CHARACTERS),
        "",
        "... output truncated",
    ].join("\n")
}
