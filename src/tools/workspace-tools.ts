import { Buffer } from "node:buffer"
import { open, opendir, stat } from "node:fs/promises"
import { isAbsolute, resolve, sep, win32 } from "node:path"

import type { IAgentTool } from "@/agent/agent-types"
import { createApplyPatchTool } from "@/tools/apply-patch-tool"
import { createBashTool } from "@/tools/bash-tool"
import {
    createRipgrepExecutableResolver,
    runRipgrep,
} from "@/tools/ripgrep"
import {
    createWorkspacePathResolver,
    toWorkspaceRelativePath,
} from "@/tools/workspace-path"

const READ_DEFAULT_LIMIT = 2_000
const READ_MAX_LINES = 2_000
const READ_MAX_BYTES = 50 * 1024
const RENDERED_LINE_MAX_CHARACTERS = 2_000
const BINARY_SAMPLE_BYTES = 8 * 1024
const FILE_READ_CHUNK_BYTES = 64 * 1024
const READ_MAX_FILE_BYTES = 4 * 1024 * 1024
const READ_MAX_DIRECTORY_ENTRIES = 100_000
const SEARCH_DEFAULT_LIMIT = 100
const SEARCH_MAX_LIMIT = 200
const GLOB_TIMEOUT_MS = 10_000
const GREP_TIMEOUT_MS = 30_000
const EXCLUDED_SEARCH_GLOBS = [
    "!**/.git",
    "!**/.git/**",
    "!**/node_modules",
    "!**/node_modules/**",
] as const

export function createWorkspaceTools(
    workspaceRoot: string,
    options: {
        readonly ripgrepSearchPath?: string
        readonly ripgrepPathExt?: string
    } = {},
): readonly IAgentTool[] {
    const resolveWorkspacePath = createWorkspacePathResolver(workspaceRoot)
    const resolveRipgrepExecutable = createRipgrepExecutableResolver(
        workspaceRoot,
        {
            ...(options.ripgrepSearchPath === undefined
                ? {}
                : { searchPath: options.ripgrepSearchPath }),
            ...(options.ripgrepPathExt === undefined
                ? {}
                : { pathExt: options.ripgrepPathExt }),
        },
    )

    const read: IAgentTool = {
        name: "read",
        description: "Read a text file or list a directory in the workspace.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    minLength: 1,
                    description: "Relative path, or an absolute path inside the workspace",
                },
                offset: {
                    type: "integer",
                    minimum: 1,
                    default: 1,
                    description: "First line or directory entry to return (1-based)",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: READ_DEFAULT_LIMIT,
                    default: READ_DEFAULT_LIMIT,
                    description: "Maximum number of lines or entries to return",
                },
            },
            required: ["path"],
            additionalProperties: false,
        },
        execute: async (input, context) => {
            const path = requireNonEmptyString(input, "path")
            const offset = optionalInteger(input, "offset", 1, 1)
            const limit = optionalInteger(
                input,
                "limit",
                READ_DEFAULT_LIMIT,
                1,
                READ_DEFAULT_LIMIT,
            )
            const resolved = await resolveWorkspacePath(path, context.signal)
            const pathStat = await safeStat(resolved.target, path)
            context.signal.throwIfAborted()

            if (pathStat.isDirectory()) {
                return await readDirectory(
                    resolved.target,
                    path,
                    offset,
                    limit,
                    context.signal,
                )
            }
            if (!pathStat.isFile()) {
                throw new Error(`Path is not a regular file or directory: ${JSON.stringify(path)}`)
            }
            rejectOversizedFile(pathStat.size, path)
            return await readTextFile(
                resolved.target,
                path,
                offset,
                limit,
                context.signal,
            )
        },
    }

    const glob: IAgentTool = {
        name: "glob",
        description: "Find workspace files using a relative glob pattern.",
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
            const resolved = await resolveWorkspacePath(path, context.signal)
            const pathStat = await safeStat(resolved.target, path)
            context.signal.throwIfAborted()
            if (!pathStat.isDirectory()) {
                throw new Error(`Glob path is not a directory: ${JSON.stringify(path)}`)
            }

            const matcher = new Bun.Glob(pattern)
            const matches: string[] = []
            const args = [
                "--files",
                "--no-config",
                "--no-require-git",
                "--sort=path",
                "--null",
                ...(hidden ? ["--hidden"] : []),
                ...globArguments(EXCLUDED_SEARCH_GLOBS),
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
                    const target = resolve(resolved.target, record)
                    const workspacePath = toWorkspaceRelativePath(resolved.root, target)
                    if (
                        hasExcludedSearchSegment(workspacePath)
                        || (!hidden && hasHiddenSegment(workspacePath))
                    ) return
                    matches.push(singleLine(workspacePath))
                    if (matches.length > limit) stop()
                },
            })

            if (!result.stoppedEarly && result.exitCode !== 0) {
                throw new Error(
                    `ripgrep glob failed: ${result.stderr || `exit code ${result.exitCode}`}`,
                )
            }

            matches.sort(compareStrings)
            if (matches.length === 0) return "No files found"
            const visible = matches.slice(0, limit)
            if (matches.length > limit) visible.push(`... results truncated at limit ${limit}`)
            return visible.join("\n")
        },
    }

    const grep: IAgentTool = {
        name: "grep",
        description: "Search workspace text with ripgrep regular expressions.",
        inputSchema: {
            type: "object",
            properties: {
                pattern: {
                    type: "string",
                    minLength: 1,
                    description: "Non-empty regular expression or literal text to find",
                },
                path: {
                    type: "string",
                    minLength: 1,
                    description: "File or directory to search inside the workspace",
                },
                include: {
                    type: "string",
                    minLength: 1,
                    description: "Only search files matching this glob",
                },
                literal: {
                    type: "boolean",
                    default: false,
                    description: "Treat pattern as literal text instead of a regular expression",
                },
                caseSensitive: {
                    type: "boolean",
                    default: true,
                    description: "Match letter case",
                },
                context: {
                    type: "integer",
                    minimum: 0,
                    maximum: 10,
                    default: 0,
                    description: "Context lines to show before and after each match",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: SEARCH_MAX_LIMIT,
                    default: SEARCH_DEFAULT_LIMIT,
                    description: "Maximum number of matching lines to return",
                },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
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
                ...globArguments(EXCLUDED_SEARCH_GLOBS),
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

    return [
        read,
        glob,
        grep,
        createApplyPatchTool(workspaceRoot),
        createBashTool(workspaceRoot),
    ]
}

async function readDirectory(
    target: string,
    displayPath: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
): Promise<string> {
    signal.throwIfAborted()
    let directory
    try {
        directory = await opendir(target)
    } catch (error) {
        throw new Error(`Cannot list directory ${JSON.stringify(displayPath)}: ${errorMessage(error)}`)
    }

    const names: string[] = []
    const cardinalityError = new Error(
        `Directory has more than ${READ_MAX_DIRECTORY_ENTRIES} entries and cannot be read: `
            + JSON.stringify(displayPath),
    )
    try {
        for await (const entry of directory) {
            signal.throwIfAborted()
            if (names.length >= READ_MAX_DIRECTORY_ENTRIES) throw cardinalityError
            names.push(singleLine(entry.name) + (entry.isDirectory() ? "/" : ""))
        }
    } catch (error) {
        signal.throwIfAborted()
        if (error === cardinalityError) throw error
        throw new Error(
            `Cannot list directory ${JSON.stringify(displayPath)}: ${errorMessage(error)}`,
        )
    }
    signal.throwIfAborted()

    names.sort(compareStrings)
    if (names.length === 0) return "Directory is empty"
    if (offset > names.length) {
        return `Offset ${offset} is beyond end of directory (${names.length} entries)`
    }

    return renderRange(names, offset, limit)
}

async function readTextFile(
    target: string,
    displayPath: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
): Promise<string> {
    let handle
    try {
        handle = await open(target, "r")
    } catch (error) {
        throw new Error(`Cannot read file ${JSON.stringify(displayPath)}: ${errorMessage(error)}`)
    }

    try {
        signal.throwIfAborted()
        const openedStat = await handle.stat()
        signal.throwIfAborted()
        rejectOversizedFile(openedStat.size, displayPath)
        const sample = Buffer.allocUnsafe(BINARY_SAMPLE_BYTES)
        const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0)
        signal.throwIfAborted()
        if (isLikelyBinary(sample.subarray(0, bytesRead), bytesRead < sample.byteLength)) {
            throw new Error(
                `File appears to be binary and cannot be read as text: ${JSON.stringify(displayPath)}`,
            )
        }

        const lines: Array<{ readonly number: number; readonly text: string }> = []
        let outputBytes = 0
        let totalLines = 0
        let continuationOffset: number | undefined

        try {
            for await (const line of streamTextLines(handle, signal)) {
                totalLines = line.number
                if (line.number < offset) continue
                if (lines.length >= limit) {
                    continuationOffset = line.number
                    break
                }

                const rendered = renderNumberedLine(line.number, line.text, line.truncated)
                const renderedBytes = Buffer.byteLength(rendered, "utf8")
                const separatorBytes = lines.length > 0 ? 1 : 0
                if (outputBytes + separatorBytes + renderedBytes > READ_MAX_BYTES) {
                    continuationOffset = line.number
                    break
                }
                lines.push({ number: line.number, text: rendered })
                outputBytes += separatorBytes + renderedBytes
            }
        } catch (error) {
            signal.throwIfAborted()
            if (error instanceof TypeError) {
                throw new Error(
                    `File appears to be binary and cannot be read as text: ${JSON.stringify(displayPath)}`,
                )
            }
            throw error
        }

        signal.throwIfAborted()
        if (totalLines === 0) return "File is empty"
        if (lines.length === 0 && continuationOffset === undefined) {
            return `Offset ${offset} is beyond end of file (${totalLines} lines)`
        }

        if (continuationOffset !== undefined) {
            const marker = (): string => (
                `... truncated; continue with offset ${continuationOffset}`
            )
            while (lines.length > 0 && (
                lines.length + 1 > READ_MAX_LINES
                || outputBytes + 1 + Buffer.byteLength(marker(), "utf8") > READ_MAX_BYTES
            )) {
                const removed = lines.pop()
                if (!removed) break
                continuationOffset = removed.number
                outputBytes -= Buffer.byteLength(removed.text, "utf8")
                if (lines.length > 0) outputBytes -= 1
            }
            return [...lines.map((line) => line.text), marker()].join("\n")
        }

        return lines.map((line) => line.text).join("\n")
    } finally {
        await handle.close()
    }
}

interface IStreamedLine {
    readonly number: number
    readonly text: string
    readonly truncated: boolean
}

async function* streamTextLines(
    handle: Awaited<ReturnType<typeof open>>,
    signal: AbortSignal,
): AsyncGenerator<IStreamedLine> {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const buffer = Buffer.allocUnsafe(FILE_READ_CHUNK_BYTES)
    let position = 0
    let lineNumber = 1
    let line = ""
    let lineCharacters = 0
    let lineTruncated = false

    const append = (value: string): void => {
        if (lineTruncated) return
        for (const character of value) {
            if (lineCharacters >= RENDERED_LINE_MAX_CHARACTERS) {
                lineTruncated = true
                return
            }
            line += character
            lineCharacters += 1
        }
    }
    const finishLine = (): IStreamedLine => {
        const text = !lineTruncated && line.endsWith("\r") ? line.slice(0, -1) : line
        const result = { number: lineNumber, text, truncated: lineTruncated }
        lineNumber += 1
        line = ""
        lineCharacters = 0
        lineTruncated = false
        return result
    }

    while (true) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position)
        signal.throwIfAborted()
        if (bytesRead === 0) break
        position += bytesRead
        const decoded = decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
        let start = 0
        for (let index = decoded.indexOf("\n"); index >= 0; index = decoded.indexOf("\n", start)) {
            append(decoded.slice(start, index))
            yield finishLine()
            start = index + 1
        }
        append(decoded.slice(start))
    }

    const finalText = decoder.decode()
    append(finalText)
    if (lineCharacters > 0 || lineTruncated) yield finishLine()
}

function isLikelyBinary(sample: Uint8Array, completeSample: boolean): boolean {
    if (sample.includes(0) || hasBinarySignature(sample)) return true

    let controls = 0
    for (const byte of sample) {
        if (
            byte < 8
            || byte === 11
            || byte === 12
            || (byte >= 14 && byte < 32)
            || byte === 127
        ) controls += 1
    }
    if (sample.byteLength > 0 && controls / sample.byteLength > 0.1) return true

    try {
        const decoder = new TextDecoder("utf-8", { fatal: true })
        decoder.decode(sample, { stream: !completeSample })
        if (completeSample) decoder.decode()
        return false
    } catch {
        return true
    }
}

function renderRange(values: readonly string[], offset: number, limit: number): string {
    const visible: Array<{
        readonly offset: number
        readonly text: string
        readonly bytes: number
    }> = []
    let outputBytes = 0
    let nextOffset: number | undefined

    for (let index = offset - 1; index < values.length; index += 1) {
        if (visible.length >= limit) {
            nextOffset = index + 1
            break
        }
        const text = truncateCharacters(
            values[index] ?? "",
            RENDERED_LINE_MAX_CHARACTERS,
            "... [entry truncated]",
        )
        const bytes = Buffer.byteLength(text, "utf8")
        if (outputBytes + (visible.length > 0 ? 1 : 0) + bytes > READ_MAX_BYTES) {
            nextOffset = index + 1
            break
        }
        visible.push({ offset: index + 1, text, bytes })
        outputBytes += (visible.length > 1 ? 1 : 0) + bytes
    }

    if (nextOffset !== undefined) {
        const marker = (): string => `... truncated; continue with offset ${nextOffset}`
        while (visible.length > 0 && (
            visible.length + 1 > READ_MAX_LINES
            || outputBytes + 1 + Buffer.byteLength(marker(), "utf8") > READ_MAX_BYTES
        )) {
            const removed = visible.pop()
            if (!removed) break
            nextOffset = removed.offset
            outputBytes -= removed.bytes
            if (visible.length > 0) outputBytes -= 1
        }
        return [...visible.map((entry) => entry.text), marker()].join("\n")
    }
    return visible.map((entry) => entry.text).join("\n")
}

function renderNumberedLine(
    lineNumber: number,
    text: string,
    alreadyTruncated: boolean,
): string {
    const prefix = `${lineNumber}: `
    const value = prefix + text
    if (!alreadyTruncated && characterCount(value) <= RENDERED_LINE_MAX_CHARACTERS) {
        return value
    }

    const marker = "... [line truncated]"
    return prefix + truncateCharacters(
        text,
        RENDERED_LINE_MAX_CHARACTERS - characterCount(prefix),
        marker,
    )
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

function hasHiddenSegment(path: string): boolean {
    return path.split("/").some((segment) => segment.startsWith("."))
}

function hasExcludedSearchSegment(path: string): boolean {
    return path.split("/").some(
        (segment) => segment === ".git" || segment === "node_modules",
    )
}

function hasBinarySignature(sample: Uint8Array): boolean {
    const startsWith = (...bytes: number[]): boolean => (
        bytes.every((byte, index) => sample[index] === byte)
    )
    return startsWith(0x25, 0x50, 0x44, 0x46, 0x2d) // PDF
        || startsWith(0x89, 0x50, 0x4e, 0x47) // PNG
        || startsWith(0xff, 0xd8, 0xff) // JPEG
        || startsWith(0x47, 0x49, 0x46, 0x38) // GIF
        || startsWith(0x50, 0x4b, 0x03, 0x04) // ZIP and office formats
        || startsWith(0x1f, 0x8b) // gzip
        || startsWith(0x7f, 0x45, 0x4c, 0x46) // ELF
}

function decodeRipgrepValue(value: unknown, name: string): string {
    if (!isRecord(value)) throw new Error(`ripgrep returned an invalid ${name}`)
    if (typeof value.text === "string") return value.text
    if (typeof value.bytes === "string") {
        return Buffer.from(value.bytes, "base64").toString("utf8")
    }
    throw new Error(`ripgrep returned an invalid ${name}`)
}

async function safeStat(target: string, displayPath: string) {
    try {
        return await stat(target)
    } catch (error) {
        throw new Error(`Cannot inspect path ${JSON.stringify(displayPath)}: ${errorMessage(error)}`)
    }
}

function rejectOversizedFile(size: number, displayPath: string): void {
    if (size <= READ_MAX_FILE_BYTES) return
    throw new Error(
        `File is larger than 4 MiB and cannot be read: ${JSON.stringify(displayPath)}`,
    )
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

function globArguments(patterns: readonly string[]): string[] {
    return patterns.flatMap((pattern) => ["--glob", pattern])
}

function requireNonEmptyString(input: Record<string, unknown>, key: string): string {
    const value = input[key]
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }
    if (!value) throw new TypeError(`Tool input ${key} cannot be empty`)
    return value
}

function optionalString(
    input: Record<string, unknown>,
    key: string,
): string | undefined {
    const value = input[key]
    if (value === undefined) return undefined
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }
    if (!value) throw new TypeError(`Tool input ${key} cannot be empty`)
    return value
}

function optionalBoolean(
    input: Record<string, unknown>,
    key: string,
    fallback: boolean,
): boolean {
    const value = input[key]
    if (value === undefined) return fallback
    if (typeof value !== "boolean") {
        throw new TypeError(`Tool input ${key} must be a boolean`)
    }
    return value
}

function optionalInteger(
    input: Record<string, unknown>,
    key: string,
    fallback: number,
    minimum: number,
    maximum?: number,
): number {
    const value = input[key]
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new TypeError(`Tool input ${key} must be an integer of at least ${minimum}`)
    }
    if (maximum !== undefined && Number(value) > maximum) {
        throw new TypeError(`Tool input ${key} must be at most ${maximum}`)
    }
    return Number(value)
}

function rejectNul(value: string, name: string): void {
    if (value.includes("\0")) throw new Error(`${name} cannot contain a NUL byte`)
}

function singleLine(value: string): string {
    return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n")
}

function truncateCharacters(value: string, maximum: number, marker: string): string {
    const characters = [...value]
    if (characters.length <= maximum) return value
    const markerCharacters = [...marker]
    return characters
        .slice(0, Math.max(0, maximum - markerCharacters.length))
        .join("") + markerCharacters.slice(0, maximum).join("")
}

function characterCount(value: string): number {
    return [...value].length
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
