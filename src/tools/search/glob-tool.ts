import { stat } from "node:fs/promises"
import { isAbsolute, resolve, sep, win32 } from "node:path"

import type { IAgentTool } from "@/agent"
import {
    isPathInside,
    toWorkspaceRelativePath,
    type TSelectedPathResolver,
    type TWorkspacePathResolver,
} from "@/tools/paths"
import {
    runRipgrep,
    type TRipgrepExecutableResolver,
} from "@/tools/search/ripgrep"
import {
    excludedSearchGlobArguments,
    hasExcludedSearchSegment,
    optionalBoolean,
    optionalInteger,
    optionalString,
    rejectNul,
    requireNonEmptyString,
    SEARCH_DEFAULT_LIMIT,
    SEARCH_MAX_LIMIT,
    singleLine,
} from "@/tools/search/search-helpers"

const GLOB_TIMEOUT_MS = 10_000

/** Creates the tool that finds workspace files with relative glob patterns. */
export function createGlobTool(
    resolveWorkspacePath: TWorkspacePathResolver,
    resolveRipgrepExecutable: TRipgrepExecutableResolver,
    resolveSelectedPath?: TSelectedPathResolver,
): IAgentTool {
    return {
        name: "glob",
        description: "Find files in a workspace directory or a directory explicitly selected with @.",
        acceptsSelectedPathReferences: resolveSelectedPath !== undefined,
        inputSchema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    minLength: 1,
                    description: "Relative glob pattern, for example **/*.ts",
                },
                path: {
                    type: "string",
                    minLength: 1,
                    description: "Directory to search, relative to the workspace by default",
                },
                hidden: {
                    type: "boolean",
                    default: false,
                    description: "Include hidden files and directories",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: SEARCH_MAX_LIMIT,
                    default: SEARCH_DEFAULT_LIMIT,
                    description: "Maximum number of paths to return",
                },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            const pattern = requireNonEmptyString(input, "pattern")
            validateRelativeGlob(pattern, "Glob pattern")
            const path = optionalString(input, "path") ?? "."
            const hidden = optionalBoolean(input, "hidden", false)
            const limit = optionalInteger(
                input,
                "limit",
                SEARCH_DEFAULT_LIMIT,
                1,
                SEARCH_MAX_LIMIT,
            )
            const resolvePath = (candidate: string) => resolveSelectedPath
                ? resolveSelectedPath(
                    candidate,
                    context.selectedPathReferences ?? [],
                    context.signal,
                )
                : resolveWorkspacePath(candidate, context.signal)
            const resolved = await resolvePath(path)
            const pathStat = await safeStat(resolved.target, path)
            context.signal.throwIfAborted()
            if (!pathStat.isDirectory()) {
                throw new Error(`Glob path is not a directory: ${JSON.stringify(path)}`)
            }

            const matcher = new Bun.Glob(pattern)
            const matches: string[] = []
            const rawMatches: string[] = []
            const args = [
                "--files",
                "--no-config",
                "--no-require-git",
                "--sort=path",
                "--null",
                ...(hidden ? ["--hidden"] : []),
                ...excludedSearchGlobArguments(),
            ]
            const executable = await resolveRipgrepExecutable(context.signal)
            const result = await runRipgrep({
                executable,
                args,
                cwd: resolved.target,
                signal: context.signal,
                timeoutMs: GLOB_TIMEOUT_MS,
                delimiter: 0,
                onRecord: (record, stop) => {
                    if (!record) return
                    const relativeMatch = record.split(sep).join("/")
                    if (!matcher.match(relativeMatch)) return
                    rawMatches.push(record)
                    if (rawMatches.length > limit * 4) stop()
                },
            })

            if (!result.stoppedEarly && result.exitCode !== 0) {
                throw new Error(
                    `ripgrep glob failed: ${result.stderr || `exit code ${result.exitCode}`}`,
                )
            }

            for (const record of rawMatches) {
                const target = resolve(resolved.target, record)
                const authorized = await resolvePath(target)
                const display = isPathInside(authorized.root, authorized.target)
                    ? toWorkspaceRelativePath(authorized.root, authorized.target)
                    : authorized.target.split(sep).join("/")
                if (
                    hasExcludedSearchSegment(display)
                    || (!hidden && hasHiddenSegment(display))
                ) continue
                matches.push(singleLine(display))
                if (matches.length > limit) break
            }

            matches.sort(compareStrings)
            if (matches.length === 0) return "No files found"
            const visible = matches.slice(0, limit)
            if (matches.length > limit) visible.push(`... results truncated at limit ${limit}`)
            return visible.join("\n")
        },
    }
}

function validateRelativeGlob(pattern: string, name: string): void {
    rejectNul(pattern, name)
    const pathPattern = pattern.startsWith("!") ? pattern.slice(1) : pattern
    if (
        isAbsolute(pathPattern)
        || win32.isAbsolute(pathPattern)
        || pathPattern.split(/[\\/]/).includes("..")
    ) {
        throw new Error(`${name} must be relative and cannot contain parent segments`)
    }
}

function hasHiddenSegment(path: string): boolean {
    return path.split("/").some((segment) => segment.startsWith("."))
}

async function safeStat(target: string, displayPath: string) {
    try {
        return await stat(target)
    } catch (error) {
        throw new Error(`Cannot inspect path ${JSON.stringify(displayPath)}: ${errorMessage(error)}`)
    }
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
