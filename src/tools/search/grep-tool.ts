import { Buffer } from "node:buffer"
import { resolve } from "node:path"
import { Type } from "typebox"

import type { AgentTool } from "@/agent"
import {
    toWorkspaceRelativePath,
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

const GREP_TIMEOUT_MS = 30_000
const RENDERED_LINE_MAX_CHARACTERS = 2_000

const GREP_INPUT_SCHEMA = Type.Object({
    pattern: Type.String({
        minLength: 1,
        description: "Non-empty regular expression or literal text to find",
    }),
    path: Type.Optional(Type.String({
        minLength: 1,
        description: "File or directory to search inside the workspace",
    })),
    include: Type.Optional(Type.String({
        minLength: 1,
        description: "Only search files matching this glob",
    })),
    literal: Type.Optional(Type.Boolean({
        default: false,
        description: "Treat pattern as literal text instead of a regular expression",
    })),
    caseSensitive: Type.Optional(Type.Boolean({
        default: true,
        description: "Match letter case",
    })),
    context: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 10,
        default: 0,
        description: "Context lines to show before and after each match",
    })),
    limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: SEARCH_MAX_LIMIT,
        default: SEARCH_DEFAULT_LIMIT,
        description: "Maximum number of matching lines to return",
    })),
}, { additionalProperties: false })

/** Creates the tool that searches workspace text with ripgrep expressions. */
export function createGrepTool(
    resolveWorkspacePath: TWorkspacePathResolver,
    resolveRipgrepExecutable: TRipgrepExecutableResolver,
): AgentTool<typeof GREP_INPUT_SCHEMA> {
    return {
        name: "grep",
        description: "Search workspace text with ripgrep regular expressions.",
        inputSchema: GREP_INPUT_SCHEMA,
        execute: async (input, context) => {
            const pattern = requireNonEmptyString(input, "pattern")
            rejectNul(pattern, "Search pattern")
            const path = optionalString(input, "path") ?? "."
            const include = optionalString(input, "include")
            if (include !== undefined) rejectNul(include, "Include glob")
            const literal = optionalBoolean(input, "literal", false)
            const caseSensitive = optionalBoolean(input, "caseSensitive", true)
            const contextLines = optionalInteger(input, "context", 0, 0, 10)
            const limit = optionalInteger(
                input,
                "limit",
                SEARCH_DEFAULT_LIMIT,
                1,
                SEARCH_MAX_LIMIT,
            )
            const resolved = await resolveWorkspacePath(path, context.signal)
            const includeMatcher = include === undefined
                ? undefined
                : new Bun.Glob(include)
            const output: string[] = []
            let matchCount = 0
            let truncated = false
            let lastAcceptedMatch: IRipgrepSearchLine | undefined
            const pendingBeforeContext: IRipgrepSearchLine[] = []
            const args = [
                "--json",
                "--no-config",
                "--no-require-git",
                "--sort=path",
                ...(literal ? ["--fixed-strings"] : []),
                caseSensitive ? "--case-sensitive" : "--ignore-case",
                ...(contextLines > 0 ? ["--context", String(contextLines)] : []),
                ...excludedSearchGlobArguments(),
                "--",
                pattern,
                resolved.relativePath,
            ]
            const executable = await resolveRipgrepExecutable(context.signal)
            const result = await runRipgrep({
                executable,
                args,
                cwd: resolved.root,
                signal: context.signal,
                timeoutMs: GREP_TIMEOUT_MS,
                delimiter: 10,
                onRecord: (record, stop) => {
                    const searchLine = parseRipgrepLine(record, resolved.root)
                    if (!searchLine) return
                    if (hasExcludedSearchSegment(searchLine.path)) return
                    if (
                        includeMatcher
                        && !matchesInclude(includeMatcher, include ?? "", searchLine.path)
                    ) return
                    if (!searchLine.match) {
                        if (
                            lastAcceptedMatch
                            && searchLine.path === lastAcceptedMatch.path
                            && searchLine.lineNumber > lastAcceptedMatch.lineNumber
                            && searchLine.lineNumber
                                <= lastAcceptedMatch.lineNumber + contextLines
                        ) {
                            output.push(searchLine.text)
                            return
                        }
                        pendingBeforeContext.push(searchLine)
                        if (pendingBeforeContext.length > contextLines) {
                            pendingBeforeContext.shift()
                        }
                        return
                    }
                    if (matchCount >= limit) {
                        truncated = true
                        pendingBeforeContext.length = 0
                        stop()
                        return
                    }

                    matchCount += 1
                    output.push(...pendingBeforeContext
                        .filter((line) =>
                            line.path === searchLine.path
                            && line.lineNumber < searchLine.lineNumber
                            && line.lineNumber >= searchLine.lineNumber - contextLines
                        )
                        .map(({ text }) => text))
                    pendingBeforeContext.length = 0
                    output.push(searchLine.text)
                    lastAcceptedMatch = searchLine
                },
            })

            if (!result.stoppedEarly && result.exitCode === 1) return "No matches found"
            if (!result.stoppedEarly && result.exitCode !== 0) {
                if (!literal && /regex parse error/i.test(result.stderr)) {
                    throw new Error(`Invalid regular expression: ${result.stderr}`)
                }
                throw new Error(
                    `ripgrep search failed: ${result.stderr || `exit code ${result.exitCode}`}`,
                )
            }

            if (truncated) output.push(`... results truncated at limit ${limit}`)
            return output.join("\n") || "No matches found"
        },
    }
}

interface IRipgrepSearchLine {
    readonly lineNumber: number
    readonly match: boolean
    readonly path: string
    readonly text: string
}

function parseRipgrepLine(
    record: string,
    workspaceRoot: string,
): IRipgrepSearchLine | undefined {
    if (!record) return undefined
    let message: unknown
    try {
        message = JSON.parse(record)
    } catch {
        throw new Error("ripgrep returned invalid JSON output")
    }
    if (!isRecord(message) || (message.type !== "match" && message.type !== "context")) {
        return undefined
    }
    if (!isRecord(message.data)) throw new Error("ripgrep returned invalid search data")

    const path = decodeRipgrepValue(message.data.path, "path")
    const contents = decodeRipgrepValue(message.data.lines, "line")
    const lineNumber = message.data.line_number
    if (!Number.isSafeInteger(lineNumber) || Number(lineNumber) < 1) {
        throw new Error("ripgrep returned an invalid line number")
    }
    const workspacePath = singleLine(
        toWorkspaceRelativePath(workspaceRoot, resolve(workspaceRoot, path)),
    )
    const line = singleLine(contents.replace(/\n$/, "").replace(/\r$/, ""))
    const match = message.type === "match"
    const separator = match ? ":" : "-"
    return {
        match,
        lineNumber: Number(lineNumber),
        path: workspacePath,
        text: truncateCharacters(
            `${workspacePath}${separator}${lineNumber}${separator} ${line}`,
            RENDERED_LINE_MAX_CHARACTERS,
            "... [line truncated]",
        ),
    }
}

function matchesInclude(matcher: Bun.Glob, pattern: string, path: string): boolean {
    if (matcher.match(path)) return true
    if (pattern.includes("/") || pattern.includes("\\")) return false
    return matcher.match(path.slice(path.lastIndexOf("/") + 1))
}

function decodeRipgrepValue(value: unknown, name: string): string {
    if (!isRecord(value)) throw new Error(`ripgrep returned an invalid ${name}`)
    if (typeof value.text === "string") return value.text
    if (typeof value.bytes === "string") {
        return Buffer.from(value.bytes, "base64").toString("utf8")
    }
    throw new Error(`ripgrep returned an invalid ${name}`)
}

function truncateCharacters(value: string, maximum: number, marker: string): string {
    const characters = [...value]
    if (characters.length <= maximum) return value
    const markerCharacters = [...marker]
    return characters
        .slice(0, Math.max(0, maximum - markerCharacters.length))
        .join("") + markerCharacters.slice(0, maximum).join("")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}
