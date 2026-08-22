import { Buffer } from "node:buffer"
import { open, opendir, stat } from "node:fs/promises"

import type { IAgentTool } from "@/agent"
import type { TWorkspacePathResolver } from "@/tools/paths"

const READ_DEFAULT_LIMIT = 2_000
const READ_MAX_LINES = 2_000
const READ_MAX_BYTES = 50 * 1024
const RENDERED_LINE_MAX_CHARACTERS = 2_000
const BINARY_SAMPLE_BYTES = 8 * 1024
const FILE_READ_CHUNK_BYTES = 64 * 1024
const READ_MAX_FILE_BYTES = 4 * 1024 * 1024
const READ_MAX_DIRECTORY_ENTRIES = 100_000

/** Creates the tool that reads text files and lists workspace directories. */
export function createReadTool(
    resolveWorkspacePath: TWorkspacePathResolver,
): IAgentTool {
    return {
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

function requireNonEmptyString(input: Record<string, unknown>, key: string): string {
    const value = input[key]
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }
    if (!value) throw new TypeError(`Tool input ${key} cannot be empty`)
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
