import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import {
    chmod,
    mkdtemp,
    open,
    rm,
    type FileHandle,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    TOOL_OUTPUT_PARTS,
    type IStoredToolOutput,
    type IToolOutputIdentity,
    type IToolOutputPage,
    type IToolOutputStore,
    type IToolOutputWriter,
    type TToolOutputEncoding,
    type TToolOutputPart,
} from "@/agent"

export const DEFAULT_TOOL_OUTPUT_ENTRY_BYTES = 512 * 1024 * 1024
export const DEFAULT_TOOL_OUTPUT_TOTAL_BYTES = 1024 * 1024 * 1024
export const DEFAULT_TOOL_OUTPUT_MAX_ENTRIES = 10_000

const OUTPUT_ID_PREFIX = "buli-output:v1:"
const OUTPUT_ID_PATTERN = /^buli-output:v1:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{24})$/
const TOOL_OUTPUT_PART_SET = new Set<string>(TOOL_OUTPUT_PARTS)

interface IStoredPart {
    readonly path: string
    readonly bytes: number
}

interface IStoredEntry {
    readonly sessionId: string
    readonly parts: ReadonlyMap<TToolOutputPart, IStoredPart>
}

export interface IEphemeralToolOutputStoreOptions {
    readonly maximumEntryBytes?: number
    readonly maximumTotalBytes?: number
    readonly maximumEntries?: number
    readonly temporaryDirectory?: string
}

/** Stores complete tool output in a private temporary directory for this app lifetime. */
export class EphemeralToolOutputStore implements IToolOutputStore {
    readonly #lifetimeId = randomToken(12)
    readonly #maximumEntryBytes: number
    readonly #maximumTotalBytes: number
    readonly #maximumEntries: number
    readonly #temporaryDirectory: string
    readonly #entries = new Map<string, IStoredEntry>()
    readonly #writers = new Set<EphemeralToolOutputWriter>()
    #rootTask: Promise<string> | undefined
    #allocatedBytes = 0
    #disposed = false
    #disposeTask: Promise<void> | undefined

    constructor(options: IEphemeralToolOutputStoreOptions = {}) {
        this.#maximumEntryBytes = positiveSafeInteger(
            options.maximumEntryBytes ?? DEFAULT_TOOL_OUTPUT_ENTRY_BYTES,
            "maximumEntryBytes",
        )
        this.#maximumTotalBytes = positiveSafeInteger(
            options.maximumTotalBytes ?? DEFAULT_TOOL_OUTPUT_TOTAL_BYTES,
            "maximumTotalBytes",
        )
        this.#maximumEntries = positiveSafeInteger(
            options.maximumEntries ?? DEFAULT_TOOL_OUTPUT_MAX_ENTRIES,
            "maximumEntries",
        )
        if (this.#maximumEntryBytes > this.#maximumTotalBytes) {
            throw new RangeError("maximumEntryBytes cannot exceed maximumTotalBytes")
        }
        this.#temporaryDirectory = options.temporaryDirectory ?? tmpdir()
    }

    readonly store = async (
        identity: IToolOutputIdentity,
        parts: Readonly<Partial<Record<TToolOutputPart, string | Uint8Array>>>,
    ): Promise<IStoredToolOutput> => {
        const entries: [TToolOutputPart, string | Uint8Array][] = []
        for (const [part, value] of Object.entries(parts)) {
            if (!isToolOutputPart(part)) {
                throw new Error(`Unknown tool output part: ${JSON.stringify(part)}`)
            }
            if (value !== undefined) entries.push([part, value])
        }
        if (entries.length === 0) {
            throw new Error("Tool output must contain at least one part")
        }

        const writer = await this.createWriter(identity)
        try {
            for (const [part, value] of entries) {
                await writer.write(
                    part,
                    typeof value === "string" ? Buffer.from(value, "utf8") : value,
                )
            }
            return await writer.commit()
        } catch (error) {
            await writer.discard().catch(() => {})
            throw error
        }
    }

    readonly createWriter = async (
        identity: IToolOutputIdentity,
    ): Promise<IToolOutputWriter> => {
        this.#assertActive()
        assertIdentity(identity)
        if (this.#entries.size + this.#writers.size >= this.#maximumEntries) {
            throw new Error(
                `Tool output storage reached its ${this.#maximumEntries}-entry quota`,
            )
        }
        const root = await this.#root()
        this.#assertActive()
        const outputId = `${OUTPUT_ID_PREFIX}${this.#lifetimeId}:${randomToken(18)}`
        const writer = new EphemeralToolOutputWriter(
            this,
            outputId,
            structuredClone(identity),
            root,
        )
        this.#writers.add(writer)
        return writer
    }

    readonly readPage = async (options: {
        readonly sessionId: string
        readonly outputId: string
        readonly part: TToolOutputPart
        readonly encoding: TToolOutputEncoding
        readonly offset: number
        readonly maxBytes: number
        readonly maxLines: number
    }): Promise<IToolOutputPage> => {
        this.#assertActive()
        const outputId = requireNonEmptyString(options.outputId, "outputId")
        const match = OUTPUT_ID_PATTERN.exec(outputId)
        if (!match) throw new Error("Tool output ID is malformed")
        if (match[1] !== this.#lifetimeId) {
            throw new Error(
                "Tool output expired because it belongs to an earlier application lifetime; rerun the source tool",
            )
        }
        const entry = this.#entries.get(outputId)
        if (!entry) throw new Error("Tool output is unavailable or has been deleted")
        if (entry.sessionId !== options.sessionId) {
            throw new Error("Tool output is unavailable in this session")
        }
        if (!isToolOutputPart(options.part)) throw new Error("Tool output part is invalid")
        if (options.encoding !== "text" && options.encoding !== "base64") {
            throw new Error("Tool output encoding must be text or base64")
        }
        const part = entry.parts.get(options.part)
        if (!part) {
            throw new Error(`Tool output part ${JSON.stringify(options.part)} is unavailable`)
        }
        const offset = nonNegativeSafeInteger(options.offset, "offset")
        const maxBytes = positiveSafeInteger(options.maxBytes, "maxBytes")
        const maxLines = positiveSafeInteger(options.maxLines, "maxLines")
        if (offset > part.bytes) {
            throw new Error(
                `Tool output offset ${offset} is beyond the end of ${part.bytes} bytes`,
            )
        }

        const handle = await open(part.path, "r")
        try {
            const remaining = part.bytes - offset
            const lookahead = options.encoding === "text" ? 4 : 0
            const buffer = Buffer.allocUnsafe(Math.min(remaining, maxBytes + lookahead))
            const bytesRead = await readInto(handle, buffer, offset)
            const available = buffer.subarray(0, bytesRead)
            let selectedBytes = Math.min(maxBytes, available.byteLength)

            if (options.encoding === "text") {
                if (offset > 0 && isUtf8ContinuationByte(available[0])) {
                    throw new Error("Tool output offset must be a returned UTF-8 byte boundary")
                }
                if (offset + selectedBytes < part.bytes) {
                    while (
                        selectedBytes > 0
                        && isUtf8ContinuationByte(available[selectedBytes])
                    ) {
                        selectedBytes -= 1
                    }
                    if (selectedBytes === 0) {
                        throw new Error("Tool output maxBytes is too small for the next character")
                    }
                }

                let newlineCount = 0
                for (let index = 0; index < selectedBytes; index += 1) {
                    if (available[index] !== 0x0a) continue
                    newlineCount += 1
                    if (newlineCount === maxLines && index + 1 < remaining) {
                        selectedBytes = index + 1
                        break
                    }
                }
            }

            const selected = available.subarray(0, selectedBytes)
            const nextOffset = offset + selectedBytes
            let content: string
            if (options.encoding === "base64") {
                content = selected.toString("base64")
            } else {
                try {
                    content = new TextDecoder("utf-8", {
                        fatal: true,
                        ignoreBOM: true,
                    }).decode(selected)
                } catch {
                    throw new Error(
                        "Tool output contains non-UTF-8 bytes; retry this page with encoding=\"base64\"",
                    )
                }
            }
            return {
                outputId,
                part: options.part,
                encoding: options.encoding,
                offset,
                content,
                contentBytes: selectedBytes,
                totalBytes: part.bytes,
                ...(nextOffset < part.bytes ? { nextOffset } : {}),
            }
        } finally {
            await handle.close()
        }
    }

    readonly dispose = (): Promise<void> => {
        this.#disposeTask ??= this.#disposeInternal()
        return this.#disposeTask
    }

    /** Exposes no entry paths; this is only useful for lifecycle assertions in tests. */
    readonly temporaryRootForTests = async (): Promise<string | undefined> => {
        return await this.#rootTask
    }

    reserve(bytes: number, entryBytes: number): void {
        this.#assertActive()
        if (entryBytes + bytes > this.#maximumEntryBytes) {
            throw new Error(
                `Tool output exceeds the ${this.#maximumEntryBytes}-byte per-entry quota`,
            )
        }
        if (this.#allocatedBytes + bytes > this.#maximumTotalBytes) {
            throw new Error(
                `Tool outputs exceed the ${this.#maximumTotalBytes}-byte application quota`,
            )
        }
        this.#allocatedBytes += bytes
    }

    release(bytes: number): void {
        this.#allocatedBytes = Math.max(0, this.#allocatedBytes - bytes)
    }

    commitWriter(
        writer: EphemeralToolOutputWriter,
        outputId: string,
        identity: IToolOutputIdentity,
        parts: ReadonlyMap<TToolOutputPart, IStoredPart>,
    ): void {
        this.#assertActive()
        if (!this.#writers.delete(writer)) throw new Error("Tool output writer is unavailable")
        this.#entries.set(outputId, {
            sessionId: identity.sessionId,
            parts: new Map(parts),
        })
    }

    releaseWriter(writer: EphemeralToolOutputWriter): void {
        this.#writers.delete(writer)
    }

    async #root(): Promise<string> {
        this.#rootTask ??= (async () => {
            let root: string | undefined
            try {
                root = await mkdtemp(join(this.#temporaryDirectory, "buli-tool-output-"))
                await chmod(root, 0o700)
                return root
            } catch (error) {
                if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
                throw error
            }
        })()
        return await this.#rootTask
    }

    async #disposeInternal(): Promise<void> {
        if (this.#disposed) return
        this.#disposed = true
        const errors: unknown[] = []
        const writerResults = await Promise.allSettled(
            [...this.#writers].map(async (writer) => writer.discard()),
        )
        for (const result of writerResults) {
            if (result.status === "rejected") errors.push(result.reason)
        }
        const root = await this.#rootTask?.catch((error: unknown) => {
            errors.push(error)
            return undefined
        })
        if (root) {
            try {
                await rm(root, { recursive: true, force: true })
            } catch (error) {
                errors.push(error)
            }
        }
        this.#writers.clear()
        this.#entries.clear()
        this.#allocatedBytes = 0
        if (errors.length > 0) {
            throw new AggregateError(errors, "Failed to dispose tool output storage")
        }
    }

    #assertActive(): void {
        if (this.#disposed) throw new Error("Tool output store is disposed")
    }
}

type TWriterState =
    | "open"
    | "sealing"
    | "committed"
    | "discarding"
    | "discarded"
    | "failed"

class EphemeralToolOutputWriter implements IToolOutputWriter {
    readonly #store: EphemeralToolOutputStore
    readonly #outputId: string
    readonly #identity: IToolOutputIdentity
    readonly #root: string
    readonly #handles = new Map<TToolOutputPart, FileHandle>()
    readonly #parts = new Map<TToolOutputPart, IStoredPart>()
    #queue: Promise<void> = Promise.resolve()
    #bytes = 0
    #state: TWriterState = "open"
    #commitTask: Promise<IStoredToolOutput> | undefined
    #discardTask: Promise<void> | undefined
    #committedResult: IStoredToolOutput | undefined
    #quotaReleased = false

    constructor(
        store: EphemeralToolOutputStore,
        outputId: string,
        identity: IToolOutputIdentity,
        root: string,
    ) {
        this.#store = store
        this.#outputId = outputId
        this.#identity = identity
        this.#root = root
    }

    readonly write = (
        part: TToolOutputPart,
        chunk: Uint8Array,
    ): Promise<void> => {
        if (this.#state !== "open") {
            return Promise.reject(new Error("Tool output writer is no longer writable"))
        }
        if (!isToolOutputPart(part)) {
            return Promise.reject(new Error("Tool output part is invalid"))
        }
        const bytes = Buffer.from(chunk)
        const task = this.#queue.then(async () => this.#writeNow(part, bytes))
        this.#queue = task.catch(() => {})
        return task
    }

    readonly commit = (): Promise<IStoredToolOutput> => {
        if (this.#committedResult) return Promise.resolve(this.#committedResult)
        if (this.#commitTask) return this.#commitTask
        if (this.#state !== "open") {
            return Promise.reject(new Error("Tool output writer cannot be committed"))
        }
        this.#state = "sealing"
        this.#commitTask = this.#commitInternal()
        return this.#commitTask
    }

    readonly discard = (): Promise<void> => {
        if (this.#state === "discarded" || this.#state === "committed") {
            return Promise.resolve()
        }
        if (this.#discardTask) return this.#discardTask
        if (this.#commitTask) {
            this.#discardTask = this.#commitTask.then(
                () => undefined,
                async () => {
                    if (this.#state !== "discarded") await this.#discardInternal()
                },
            )
            return this.#discardTask
        }
        this.#state = "discarding"
        this.#discardTask = this.#discardInternal()
        return this.#discardTask
    }

    async #writeNow(part: TToolOutputPart, bytes: Buffer): Promise<void> {
        if (this.#state === "failed") {
            throw new Error("Tool output writer failed before this write")
        }
        try {
            this.#store.reserve(bytes.byteLength, this.#bytes)
            this.#bytes += bytes.byteLength
            let handle = this.#handles.get(part)
            if (!handle) {
                const path = join(
                    this.#root,
                    `${this.#outputId.slice(OUTPUT_ID_PREFIX.length).replaceAll(":", "-")}.${part}`,
                )
                handle = await open(path, "wx", 0o600)
                this.#handles.set(part, handle)
                this.#parts.set(part, { path, bytes: 0 })
            }
            await writeAll(handle, bytes)
            const stored = this.#parts.get(part)!
            this.#parts.set(part, {
                path: stored.path,
                bytes: stored.bytes + bytes.byteLength,
            })
        } catch (error) {
            this.#state = "failed"
            throw error
        }
    }

    async #commitInternal(): Promise<IStoredToolOutput> {
        try {
            await this.#queue
            if (this.#state === "failed") {
                throw new Error("Tool output writer failed before commit")
            }
            if (this.#parts.size === 0) {
                throw new Error("Tool output writer has no output parts")
            }
            const closeErrors = await closeHandles(this.#handles)
            if (closeErrors.length > 0) {
                throw new AggregateError(closeErrors, "Failed to close tool output files")
            }
            this.#store.commitWriter(
                this,
                this.#outputId,
                this.#identity,
                this.#parts,
            )
            this.#state = "committed"
            this.#committedResult = { outputId: this.#outputId }
            return this.#committedResult
        } catch (error) {
            let cleanupError: unknown
            try {
                await this.#discardInternal()
            } catch (caught) {
                cleanupError = caught
            }
            if (cleanupError !== undefined) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Tool output commit and cleanup failed",
                )
            }
            throw error
        }
    }

    async #discardInternal(): Promise<void> {
        if (this.#state === "discarded" || this.#state === "committed") return
        if (this.#state !== "failed") this.#state = "discarding"
        await this.#queue.catch(() => {})
        const closeErrors = await closeHandles(this.#handles)
        const removeResults = await Promise.allSettled(
            [...this.#parts.values()].map(async (part) => {
                await rm(part.path, { force: true })
            }),
        )
        const removeErrors = removeResults.flatMap((result) => (
            result.status === "rejected" ? [result.reason] : []
        ))
        if (removeErrors.length > 0) {
            this.#state = "failed"
            throw new AggregateError(
                [...closeErrors, ...removeErrors],
                "Failed to discard tool output files",
            )
        }
        if (!this.#quotaReleased) {
            this.#store.release(this.#bytes)
            this.#quotaReleased = true
        }
        this.#store.releaseWriter(this)
        this.#state = "discarded"
        if (closeErrors.length > 0) {
            throw new AggregateError(closeErrors, "Failed to close discarded output files")
        }
    }
}

async function readInto(
    handle: FileHandle,
    buffer: Buffer,
    position: number,
): Promise<number> {
    let total = 0
    while (total < buffer.byteLength) {
        const result = await handle.read(
            buffer,
            total,
            buffer.byteLength - total,
            position + total,
        )
        if (result.bytesRead === 0) break
        total += result.bytesRead
    }
    return total
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
    let offset = 0
    while (offset < bytes.byteLength) {
        const result = await handle.write(bytes, offset, bytes.byteLength - offset, null)
        if (result.bytesWritten <= 0) throw new Error("Tool output write made no progress")
        offset += result.bytesWritten
    }
}

async function closeHandles(
    handles: Map<TToolOutputPart, FileHandle>,
): Promise<unknown[]> {
    const errors: unknown[] = []
    for (const [part, handle] of [...handles]) {
        try {
            await handle.close()
            handles.delete(part)
        } catch (error) {
            errors.push(error)
        }
    }
    return errors
}

function randomToken(bytes: number): string {
    return randomBytes(bytes).toString("base64url")
}

function isToolOutputPart(value: string): value is TToolOutputPart {
    return TOOL_OUTPUT_PART_SET.has(value)
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
    return value !== undefined && (value & 0xc0) === 0x80
}

function positiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`)
    }
    return value
}

function nonNegativeSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`)
    }
    return value
}

function requireNonEmptyString(value: string, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${name} must be a nonempty string`)
    }
    return value
}

function assertIdentity(identity: IToolOutputIdentity): void {
    requireNonEmptyString(identity.sessionId, "sessionId")
    requireNonEmptyString(identity.runId, "runId")
    requireNonEmptyString(identity.toolCallId, "toolCallId")
    requireNonEmptyString(identity.toolName, "toolName")
}
