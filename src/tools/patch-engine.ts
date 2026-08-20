import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path"

import { createUnifiedDiff, UnifiedDiffTooLargeError } from "@/tools/diff"

export const WORKSPACE_PATCH_MAX_PATCH_BYTES = 500 * 1024
export const WORKSPACE_PATCH_MAX_OPERATIONS = 50
export const WORKSPACE_PATCH_MAX_SOURCE_BYTES = 1024 * 1024
export const WORKSPACE_PATCH_MAX_AGGREGATE_BYTES = 4 * 1024 * 1024
export const WORKSPACE_PATCH_MAX_DIFF_BYTES = 500 * 1024
const WORKSPACE_PATCH_MAX_PATCH_LINES = 50_000
const WORKSPACE_PATCH_MAX_SOURCE_LINES = 100_000

export interface IPlanWorkspacePatchOptions {
    readonly patchText: string
    readonly workspaceRoot: string
    readonly signal: AbortSignal
}

export interface IWorkspacePatchSummary {
    readonly filesChanged: number
    readonly additions: number
    readonly deletions: number
    readonly text: string
}

export interface IWorkspacePatchPlan {
    readonly diff: string
    readonly affectedPaths: readonly string[]
    readonly summary: IWorkspacePatchSummary
}

export interface IApplyWorkspacePatchOptions {
    readonly plan: IWorkspacePatchPlan
    readonly signal: AbortSignal
}

export interface IWorkspacePatchApplyResult {
    readonly applied: true
    readonly affectedPaths: readonly string[]
    readonly filesChanged: number
    readonly summary: string
}

export class StaleWorkspacePatchError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause })
        this.name = "StaleWorkspacePatchError"
    }
}

export class WorkspacePatchCommittedAfterAbortError extends Error {
    readonly committed = true
    readonly result: IWorkspacePatchApplyResult

    constructor(result: IWorkspacePatchApplyResult, cause: unknown) {
        super(
            `The workspace patch committed after cancellation began: ${result.summary}`,
            { cause },
        )
        this.name = "WorkspacePatchCommittedAfterAbortError"
        this.result = result
    }
}

class WorkspacePatchSideEffectsUnknownError extends AggregateError {
    readonly sideEffectsUnknown = true

    constructor(errors: readonly unknown[], message: string) {
        super(errors, message)
        this.name = "WorkspacePatchSideEffectsUnknownError"
    }
}

type TPatchLineKind = "add" | "context" | "remove"
type TLineEnding = "" | "\n" | "\r" | "\r\n"

interface IParsedPatchLine { readonly kind: TPatchLineKind; readonly text: string }
interface IParsedUpdateChunk {
    readonly anchor: string | null
    readonly lines: readonly IParsedPatchLine[]
    readonly endOfFile: boolean
    readonly lineNumber: number
}

interface IParsedAdd { readonly kind: "add"; readonly path: string; readonly lines: readonly string[]; readonly lineNumber: number }
interface IParsedDelete { readonly kind: "delete"; readonly path: string; readonly lineNumber: number }
interface IParsedUpdate {
    readonly kind: "update"
    readonly path: string
    readonly movePath: string | null
    readonly chunks: readonly IParsedUpdateChunk[]
    readonly lineNumber: number
}

type TParsedHunk = IParsedAdd | IParsedDelete | IParsedUpdate
interface IMutableChunk { anchor: string | null; lines: IParsedPatchLine[]; endOfFile: boolean; lineNumber: number }
interface IResolvedMutationPath {
    readonly requestedPath: string
    readonly absolutePath: string
    readonly relativePath: string
    readonly exists: boolean
}

interface ISourceLine { readonly text: string; readonly ending: TLineEnding }
interface IMutableSourceLine { text: string; ending: TLineEnding }
interface ISourceFile {
    readonly bytes: Buffer
    readonly hasBom: boolean
    readonly lines: readonly ISourceLine[]
    readonly dominantEnding: Exclude<TLineEnding, "">
    readonly mode: number
}

interface IExactFileState {
    readonly path: string
    readonly requestedPath: string
    readonly content: Buffer
    readonly revision: string
    readonly mode: number
}

interface IExactChange {
    readonly kind: "add" | "delete" | "move" | "update"
    readonly source: IExactFileState | null
    readonly destination: IExactFileState | null
}

type TWriteChange = IExactChange & { readonly destination: IExactFileState }
type TDeleteChange = IExactChange & { readonly source: IExactFileState }
interface IInternalPatchPlan { readonly workspaceRoot: string; readonly changes: readonly IExactChange[] }
interface ILineReplacement { readonly start: number; readonly oldLength: number; readonly lines: readonly IMutableSourceLine[] }
interface IStagedWrite {
    readonly change: TWriteChange
    readonly path: string
    readonly absolutePath: string
    readonly temporaryPath: string
}

interface IFileState { readonly bytes: Buffer; readonly mode: number }

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const MODE_MASK = 0o7777
const TEMP_FILE_ATTEMPTS = 10
const privatePlans = new WeakMap<IWorkspacePatchPlan, IInternalPatchPlan>()

let mutationQueue: Promise<void> = Promise.resolve()

/** Parses and fully preflights a patch without mutating the workspace. */
export async function planWorkspacePatch(
    options: IPlanWorkspacePatchOptions,
): Promise<IWorkspacePatchPlan> {
    assertSignal(options.signal)
    options.signal.throwIfAborted()
    if (typeof options.patchText !== "string") {
        throw new TypeError("patchText must be a string")
    }
    if (Buffer.byteLength(options.patchText, "utf8") > WORKSPACE_PATCH_MAX_PATCH_BYTES) {
        throw new Error(
            "Patch text exceeds the 500 KiB limit. Split the work into smaller patches; "
            + "no workspace files were changed.",
        )
    }
    if (!isWellFormed(options.patchText)) {
        throw new Error("Patch text must contain well-formed Unicode")
    }

    const hunks = parsePatch(options.patchText)
    for (const hunk of hunks) {
        validatePatchPath(hunk.path)
        if (hunk.kind === "update" && hunk.movePath !== null) {
            validatePatchPath(hunk.movePath)
        }
    }

    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot, options.signal)
    const reservedPaths = new Map<string, string>()
    const changes: IExactChange[] = []
    let aggregateBytes = 0

    for (const hunk of hunks) {
        options.signal.throwIfAborted()
        if (hunk.kind === "add") {
            const destination = await resolveMutationPath(
                workspaceRoot,
                hunk.path,
                options.signal,
            )
            if (destination.exists) {
                throw new Error(`Cannot add an existing path: ${quote(hunk.path)}`)
            }
            reservePath(reservedPaths, destination.relativePath, `add ${quote(hunk.path)}`)
            const content = Buffer.from(`${hunk.lines.join("\n")}\n`, "utf8")
            assertTextFileBytes(content, hunk.path)
            aggregateBytes = includeContentBytes(aggregateBytes, content.byteLength)
            changes.push({
                kind: "add",
                source: null,
                destination: {
                    path: destination.relativePath,
                    requestedPath: hunk.path,
                    content,
                    revision: fileRevision(content),
                    mode: defaultFileMode(),
                },
            })
            continue
        }

        const sourcePath = await resolveMutationPath(
            workspaceRoot,
            hunk.path,
            options.signal,
        )
        if (!sourcePath.exists) {
            throw new Error(`Path to ${hunk.kind} does not exist: ${quote(hunk.path)}`)
        }
        reservePath(
            reservedPaths,
            sourcePath.relativePath,
            `${hunk.kind} ${quote(hunk.path)}`,
        )
        const source = await readSourceFile(sourcePath, options.signal)
        aggregateBytes = includeContentBytes(aggregateBytes, source.bytes.byteLength)
        const sourceState: IExactFileState = {
            path: sourcePath.relativePath,
            requestedPath: hunk.path,
            content: source.bytes,
            revision: fileRevision(source.bytes),
            mode: source.mode,
        }

        if (hunk.kind === "delete") {
            changes.push({ kind: "delete", source: sourceState, destination: null })
            continue
        }

        const content = applyUpdateChunks(source, hunk.chunks, hunk.path)
        if (content.equals(source.bytes)) {
            throw new Error(`Update produces no changes: ${quote(hunk.path)}`)
        }
        assertTextFileBytes(content, hunk.movePath ?? hunk.path)
        aggregateBytes = includeContentBytes(aggregateBytes, content.byteLength)
        const finalRevision = fileRevision(content)

        if (hunk.movePath === null) {
            changes.push({
                kind: "update",
                source: sourceState,
                destination: {
                    path: sourcePath.relativePath,
                    requestedPath: hunk.path,
                    content,
                    revision: finalRevision,
                    mode: source.mode,
                },
            })
            continue
        }

        const destination = await resolveMutationPath(
            workspaceRoot,
            hunk.movePath,
            options.signal,
        )
        if (destination.exists) {
            throw new Error(`Move destination already exists: ${quote(hunk.movePath)}`)
        }
        reservePath(
            reservedPaths,
            destination.relativePath,
            `move destination ${quote(hunk.movePath)}`,
        )
        changes.push({
            kind: "move",
            source: sourceState,
            destination: {
                path: destination.relativePath,
                requestedPath: hunk.movePath,
                content,
                revision: finalRevision,
                mode: source.mode,
            },
        })
    }

    const affectedPaths = affectedPathsFor(changes)
    const rendered = renderPlanDiff(changes)
    const summary = patchSummary(changes.length, rendered.additions, rendered.deletions)
    const plan: IWorkspacePatchPlan = {
        diff: rendered.text,
        affectedPaths,
        summary,
    }
    deepFreeze(plan)
    privatePlans.set(plan, { workspaceRoot, changes })
    return plan
}

/** Applies an ephemeral plan after stale-state checks under a global mutation lock. */
export async function applyWorkspacePatch(
    options: IApplyWorkspacePatchOptions,
): Promise<IWorkspacePatchApplyResult> {
    assertSignal(options.signal)
    options.signal.throwIfAborted()
    const internalPlan = privatePlans.get(options.plan)
    if (internalPlan === undefined) {
        throw new Error("Workspace patch plan was not issued by this module")
    }
    return await serializeMutation(async () => {
        options.signal.throwIfAborted()
        return await applyInternalPatch(internalPlan, options.plan, options.signal)
    })
}

function parsePatch(patchText: string): readonly TParsedHunk[] {
    const lines = splitPatchLines(patchText)
    if (lines.length > WORKSPACE_PATCH_MAX_PATCH_LINES) {
        throw new Error(
            `Patch contains more than ${WORKSPACE_PATCH_MAX_PATCH_LINES} lines. Split the work into smaller patches.`,
        )
    }
    if (lines[0] !== "*** Begin Patch") {
        throw new Error("The first patch line must be exactly '*** Begin Patch'")
    }
    if (lines[lines.length - 1] !== "*** End Patch") {
        throw new Error("The last patch line must be exactly '*** End Patch'")
    }

    const hunks: TParsedHunk[] = []
    const endIndex = lines.length - 1
    let index = 1
    while (index < endIndex) {
        if (hunks.length >= WORKSPACE_PATCH_MAX_OPERATIONS) {
            throw new Error(`Patch cannot contain more than ${WORKSPACE_PATCH_MAX_OPERATIONS} operations`)
        }
        const line = lines[index] ?? ""
        const lineNumber = index + 1
        const header = parseHunkHeader(line, lineNumber)

        if (header.kind === "add") {
            const addedLines: string[] = []
            index += 1
            while (index < endIndex && !isHunkHeader(lines[index] ?? "")) {
                const contentLine = lines[index] ?? ""
                if (!contentLine.startsWith("+")) {
                    throw patchLineError(index, "Every Add File content line must start with '+'")
                }
                addedLines.push(contentLine.slice(1))
                index += 1
            }
            if (addedLines.length === 0) {
                throw patchLineError(lineNumber - 1, "Add File must contain at least one '+' line")
            }
            hunks.push({ ...header, lines: addedLines })
            continue
        }

        if (header.kind === "delete") {
            hunks.push(header)
            index += 1
            continue
        }

        index += 1
        let movePath: string | null = null
        const possibleMove = lines[index] ?? ""
        if (possibleMove.startsWith("*** Move to: ")) {
            movePath = possibleMove.slice("*** Move to: ".length)
            index += 1
        }

        const chunks: IParsedUpdateChunk[] = []
        let currentChunk: IMutableChunk | null = null
        let sawEndOfFile = false
        while (index < endIndex && !isHunkHeader(lines[index] ?? "")) {
            const updateLine = lines[index] ?? ""
            if (sawEndOfFile) {
                throw patchLineError(index, "'*** End of File' must end an Update File hunk")
            }

            if (updateLine === "@@" || updateLine.startsWith("@@ ")) {
                if (currentChunk !== null) chunks.push(finishChunk(currentChunk))
                const anchor = updateLine === "@@" ? null : updateLine.slice(3)
                if (anchor !== null) validateAnchor(anchor, index)
                currentChunk = {
                    anchor,
                    lines: [],
                    endOfFile: false,
                    lineNumber: index + 1,
                }
                index += 1
                continue
            }

            if (updateLine === "*** End of File") {
                if (currentChunk === null || currentChunk.lines.length === 0) {
                    throw patchLineError(index, "'*** End of File' requires a non-empty chunk")
                }
                currentChunk.endOfFile = true
                sawEndOfFile = true
                index += 1
                continue
            }

            const marker = updateLine[0]
            if (marker !== " " && marker !== "+" && marker !== "-") {
                throw patchLineError(
                    index,
                    "Update lines must start with ' ', '+', '-', or a nonnumeric '@@' anchor",
                )
            }
            currentChunk ??= {
                anchor: null,
                lines: [],
                endOfFile: false,
                lineNumber: index + 1,
            }
            currentChunk.lines.push({
                kind: marker === " " ? "context" : marker === "+" ? "add" : "remove",
                text: updateLine.slice(1),
            })
            index += 1
        }
        if (currentChunk !== null) chunks.push(finishChunk(currentChunk))
        if (chunks.length === 0) {
            throw patchLineError(lineNumber - 1, "Update File must contain at least one chunk")
        }
        hunks.push({ ...header, movePath, chunks })
    }

    if (hunks.length === 0) throw new Error("Patch must contain at least one file hunk")
    return hunks
}

function splitPatchLines(patchText: string): readonly string[] {
    if (patchText.length === 0) return []
    const lines = patchText.split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line)
}

function parseHunkHeader(line: string, lineNumber: number): TParsedHunk {
    if (line.startsWith("*** Add File: ")) {
        return {
            kind: "add",
            path: line.slice("*** Add File: ".length),
            lines: [],
            lineNumber,
        }
    }
    if (line.startsWith("*** Delete File: ")) {
        return {
            kind: "delete",
            path: line.slice("*** Delete File: ".length),
            lineNumber,
        }
    }
    if (line.startsWith("*** Update File: ")) {
        return {
            kind: "update",
            path: line.slice("*** Update File: ".length),
            movePath: null,
            chunks: [],
            lineNumber,
        }
    }
    throw patchLineError(
        lineNumber - 1,
        "Expected '*** Add File:', '*** Update File:', or '*** Delete File:'",
    )
}

function isHunkHeader(line: string): boolean {
    return line.startsWith("*** Add File: ")
        || line.startsWith("*** Delete File: ")
        || line.startsWith("*** Update File: ")
}

function finishChunk(chunk: IMutableChunk): IParsedUpdateChunk {
    if (chunk.lines.length === 0) {
        throw patchLineError(chunk.lineNumber - 1, "Update chunk cannot be empty")
    }
    const oldLines = chunk.lines
        .filter(({ kind }) => kind !== "add")
        .map(({ text }) => text)
    const newLines = chunk.lines
        .filter(({ kind }) => kind !== "remove")
        .map(({ text }) => text)
    const hasEditMarkers = chunk.lines.some(({ kind }) => kind !== "context")
    if (!hasEditMarkers || arraysEqual(oldLines, newLines)) {
        throw patchLineError(chunk.lineNumber - 1, "Update chunk is a no-op")
    }
    return {
        anchor: chunk.anchor,
        lines: chunk.lines,
        endOfFile: chunk.endOfFile,
        lineNumber: chunk.lineNumber,
    }
}

function validateAnchor(anchor: string, zeroBasedLine: number): void {
    if (anchor.length === 0 || /^[+-]?\d/.test(anchor.trimStart())) {
        throw patchLineError(zeroBasedLine, "Update anchors must be nonempty and nonnumeric")
    }
}

function patchLineError(zeroBasedLine: number, message: string): Error {
    return new Error(`Invalid patch at line ${zeroBasedLine + 1}: ${message}`)
}

function validatePatchPath(path: string): void {
    if (path.length === 0) throw new Error("Patch paths cannot be empty")
    if (path.includes("\0")) throw new Error(`Patch path cannot contain a NUL byte: ${quote(path)}`)
    const segments = path.split(/[\\/]/)
    if (
        isAbsolute(path)
        || posix.isAbsolute(path)
        || win32.isAbsolute(path)
        || /^[A-Za-z]:/.test(path)
        || segments.includes("..")
    ) {
        throw new Error(
            `Patch path must be workspace-relative without parent segments: ${quote(path)}`,
        )
    }
    if (segments.some((segment) => segment.toLowerCase() === ".git")) {
        throw new Error(`Patch cannot modify .git internals: ${quote(path)}`)
    }
}

async function resolveWorkspaceRoot(
    workspaceRoot: string,
    signal?: AbortSignal,
): Promise<string> {
    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
        throw new TypeError("workspaceRoot must be a nonempty string")
    }
    if (workspaceRoot.includes("\0")) throw new Error("workspaceRoot cannot contain a NUL byte")
    throwIfAborted(signal)
    let root: string
    try {
        root = await realpath(resolve(workspaceRoot))
    } catch (error) {
        throw new Error(`Cannot resolve workspace root: ${errorMessage(error)}`, { cause: error })
    }
    throwIfAborted(signal)
    const rootStat = await stat(root)
    throwIfAborted(signal)
    if (!rootStat.isDirectory()) throw new Error("Workspace root must be a directory")
    if (hasGitSegment(root)) {
        throw new Error("Workspace root cannot be inside .git internals")
    }
    return root
}

async function resolveMutationPath(
    root: string,
    requestedPath: string,
    signal?: AbortSignal,
): Promise<IResolvedMutationPath> {
    validatePatchPath(requestedPath)
    throwIfAborted(signal)
    const candidate = resolve(root, requestedPath)
    if (!isPathInside(root, candidate)) {
        throw new Error(`Patch path is outside the workspace: ${quote(requestedPath)}`)
    }

    try {
        const canonicalTarget = await realpath(candidate)
        throwIfAborted(signal)
        return resolvedMutationPath(root, requestedPath, canonicalTarget, true)
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw new Error(
                `Cannot resolve patch path ${quote(requestedPath)}: ${errorMessage(error)}`,
                { cause: error },
            )
        }
    }

    const suffix: string[] = []
    let current = candidate
    while (true) {
        throwIfAborted(signal)
        try {
            const currentStat = await lstat(current)
            throwIfAborted(signal)
            let canonicalAncestor: string
            try {
                canonicalAncestor = await realpath(current)
            } catch (error) {
                throw new Error(
                    `Cannot resolve existing path component for ${quote(requestedPath)}: ${errorMessage(error)}`,
                    { cause: error },
                )
            }
            throwIfAborted(signal)
            if (suffix.length > 0) {
                const followedStat = currentStat.isSymbolicLink()
                    ? await stat(canonicalAncestor)
                    : currentStat
                throwIfAborted(signal)
                if (!followedStat.isDirectory()) {
                    throw new Error(
                        `A parent component is not a directory: ${quote(requestedPath)}`,
                    )
                }
            }
            const canonicalTarget = resolve(canonicalAncestor, ...suffix)
            return resolvedMutationPath(root, requestedPath, canonicalTarget, false)
        } catch (error) {
            if (!isMissingPathError(error)) throw error
        }

        const parent = dirname(current)
        if (parent === current) {
            throw new Error(`Cannot find an existing ancestor for ${quote(requestedPath)}`)
        }
        suffix.unshift(basename(current))
        current = parent
    }
}

function resolvedMutationPath(
    root: string,
    requestedPath: string,
    absolutePath: string,
    exists: boolean,
): IResolvedMutationPath {
    if (!isPathInside(root, absolutePath)) {
        throw new Error(`Patch path resolves outside the workspace: ${quote(requestedPath)}`)
    }
    const relativePath = toWorkspaceRelativePath(root, absolutePath)
    if (hasGitSegment(relativePath)) {
        throw new Error(`Patch cannot modify .git internals: ${quote(requestedPath)}`)
    }
    return { requestedPath, absolutePath, relativePath, exists }
}

async function readSourceFile(
    path: IResolvedMutationPath,
    signal: AbortSignal,
): Promise<ISourceFile> {
    const state = await readFileState(
        path.absolutePath,
        path.requestedPath,
        WORKSPACE_PATCH_MAX_SOURCE_BYTES,
        signal,
    )
    const decoded = decodeSourceBytes(state.bytes, path.requestedPath)
    const parsed = parseSourceLines(decoded.text)
    return {
        bytes: state.bytes,
        hasBom: decoded.hasBom,
        lines: parsed.lines,
        dominantEnding: parsed.dominantEnding,
        mode: state.mode,
    }
}

async function readFileState(
    absolutePath: string,
    displayPath: string,
    maxBytes: number,
    signal?: AbortSignal,
): Promise<IFileState> {
    throwIfAborted(signal)
    const metadata = await stat(absolutePath)
    throwIfAborted(signal)
    if (!metadata.isFile()) {
        throw new Error(`Patch source is not a regular file: ${quote(displayPath)}`)
    }
    if (metadata.size > maxBytes) {
        throw new Error(`Patch source exceeds ${maxBytes} bytes: ${quote(displayPath)}`)
    }

    const bytes = signal === undefined
        ? await readFile(absolutePath)
        : await readFile(absolutePath, { signal })
    throwIfAborted(signal)
    if (bytes.byteLength > maxBytes) {
        throw new Error(`Patch source exceeds ${maxBytes} bytes: ${quote(displayPath)}`)
    }
    return { bytes, mode: metadata.mode & MODE_MASK }
}

function decodeSourceBytes(
    bytes: Uint8Array,
    displayPath: string,
): { readonly text: string; readonly hasBom: boolean } {
    assertTextFileBytes(bytes, displayPath)
    const hasBom = startsWithBom(bytes)
    const body = hasBom ? bytes.subarray(UTF8_BOM.byteLength) : bytes
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    return { text: decoder.decode(body), hasBom }
}

function assertTextFileBytes(bytes: Uint8Array, displayPath: string): void {
    if (bytes.includes(0) || hasBinarySignature(bytes)) {
        throw new Error(`Patch source is binary: ${quote(displayPath)}`)
    }
    let controls = 0
    for (const byte of bytes) {
        if (
            byte < 8
            || byte === 11
            || byte === 12
            || (byte >= 14 && byte < 32)
            || byte === 127
        ) controls += 1
    }
    if (bytes.byteLength > 0 && controls / bytes.byteLength > 0.1) {
        throw new Error(`Patch source is binary: ${quote(displayPath)}`)
    }
    try {
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch (error) {
        throw new Error(`Patch source is not valid UTF-8: ${quote(displayPath)}`, {
            cause: error,
        })
    }
}

function parseSourceLines(text: string): {
    readonly lines: readonly ISourceLine[]
    readonly dominantEnding: Exclude<TLineEnding, "">
} {
    const lines: ISourceLine[] = []
    const endingCounts = new Map<Exclude<TLineEnding, "">, number>()
    const endingOrder: Array<Exclude<TLineEnding, "">> = []
    let start = 0
    let index = 0
    while (index < text.length) {
        const character = text[index]
        if (character !== "\r" && character !== "\n") {
            index += 1
            continue
        }
        const ending: Exclude<TLineEnding, ""> = character === "\r" && text[index + 1] === "\n"
            ? "\r\n"
            : character
        lines.push({ text: text.slice(start, index), ending })
        if (lines.length > WORKSPACE_PATCH_MAX_SOURCE_LINES) {
            throw new Error(
                `Patch source contains more than ${WORKSPACE_PATCH_MAX_SOURCE_LINES} lines`,
            )
        }
        if (!endingCounts.has(ending)) endingOrder.push(ending)
        endingCounts.set(ending, (endingCounts.get(ending) ?? 0) + 1)
        index += ending.length
        start = index
    }
    if (start < text.length) {
        lines.push({ text: text.slice(start), ending: "" })
        if (lines.length > WORKSPACE_PATCH_MAX_SOURCE_LINES) {
            throw new Error(
                `Patch source contains more than ${WORKSPACE_PATCH_MAX_SOURCE_LINES} lines`,
            )
        }
    }

    let dominantEnding: Exclude<TLineEnding, ""> = "\n"
    let dominantCount = 0
    for (const ending of endingOrder) {
        const count = endingCounts.get(ending) ?? 0
        if (count > dominantCount) {
            dominantEnding = ending
            dominantCount = count
        }
    }
    return { lines, dominantEnding }
}

function applyUpdateChunks(
    source: ISourceFile,
    chunks: readonly IParsedUpdateChunk[],
    displayPath: string,
): Buffer {
    const replacements: ILineReplacement[] = []
    const sourceTexts = source.lines.map(({ text }) => text)
    let cursor = 0

    for (const chunk of chunks) {
        let searchStart = cursor
        let anchorIndex: number | null = null
        if (chunk.anchor !== null) {
            const anchorMatches = matchingLineIndexes(sourceTexts, chunk.anchor, cursor)
            if (anchorMatches.length === 0) {
                throw new Error(
                    `Cannot find exact anchor ${quote(chunk.anchor)} in ${quote(displayPath)}`,
                )
            }
            if (anchorMatches.length > 1) {
                throw new Error(
                    `Exact anchor ${quote(chunk.anchor)} is ambiguous in ${quote(displayPath)}`,
                )
            }
            anchorIndex = anchorMatches[0] ?? null
            searchStart = (anchorIndex ?? -1) + 1
        }

        const oldLines = chunk.lines
            .filter(({ kind }) => kind !== "add")
            .map(({ text }) => text)
        let start: number
        if (oldLines.length === 0) {
            start = anchorIndex === null ? source.lines.length : anchorIndex + 1
            if (chunk.endOfFile) start = source.lines.length
        } else {
            const matches = matchingSequenceIndexes(
                sourceTexts,
                oldLines,
                searchStart,
                chunk.endOfFile,
            )
            if (matches.length === 0) {
                throw new Error(
                    `Cannot find exact context in ${quote(displayPath)} for chunk at line ${chunk.lineNumber}`,
                )
            }
            if (matches.length > 1) {
                throw new Error(
                    `Exact context is ambiguous in ${quote(displayPath)} for chunk at line ${chunk.lineNumber}`,
                )
            }
            start = matches[0] ?? 0
        }

        const removedEndings = new Map<IParsedPatchLine, TLineEnding>()
        let endingSourceIndex = start
        for (const line of chunk.lines) {
            if (line.kind === "add") continue
            const existing = source.lines[endingSourceIndex]
            if (!existing || existing.text !== line.text) {
                throw new Error(`Internal exact-context mismatch in ${quote(displayPath)}`)
            }
            if (line.kind === "remove") removedEndings.set(line, existing.ending)
            endingSourceIndex += 1
        }

        const replacementEndings = new Map<IParsedPatchLine, TLineEnding>()
        let editStart = 0
        for (let index = 0; index <= chunk.lines.length; index += 1) {
            const line = chunk.lines[index]
            if (index < chunk.lines.length && line?.kind !== "context") continue
            const editLines = chunk.lines.slice(editStart, index)
            const availableEndings = editLines.flatMap((editLine) => {
                const ending = removedEndings.get(editLine)
                return ending === undefined ? [] : [ending]
            })
            let endingIndex = 0
            for (const editLine of editLines) {
                if (editLine.kind !== "add") continue
                replacementEndings.set(
                    editLine,
                    availableEndings[endingIndex] ?? source.dominantEnding,
                )
                endingIndex += 1
            }
            editStart = index + 1
        }

        const replacementLines: IMutableSourceLine[] = []
        let sourceIndex = start
        for (const line of chunk.lines) {
            if (line.kind === "add") {
                replacementLines.push({
                    text: line.text,
                    ending: replacementEndings.get(line) ?? source.dominantEnding,
                })
                continue
            }
            const existing = source.lines[sourceIndex]
            if (!existing || existing.text !== line.text) {
                throw new Error(`Internal exact-context mismatch in ${quote(displayPath)}`)
            }
            if (line.kind === "context") {
                replacementLines.push({ text: existing.text, ending: existing.ending })
            }
            sourceIndex += 1
        }
        replacements.push({ start, oldLength: oldLines.length, lines: replacementLines })
        cursor = start + oldLines.length
    }

    const finalLines: IMutableSourceLine[] = source.lines.map((line) => ({ ...line }))
    for (let index = replacements.length - 1; index >= 0; index -= 1) {
        const replacement = replacements[index]
        if (!replacement) continue
        finalLines.splice(
            replacement.start,
            replacement.oldLength,
            ...replacement.lines.map((line) => ({ ...line })),
        )
    }
    for (let index = 0; index < finalLines.length - 1; index += 1) {
        const line = finalLines[index]
        if (line?.ending === "") line.ending = source.dominantEnding
    }
    const body = finalLines.map(({ text, ending }) => text + ending).join("")
    const encoded = Buffer.from(body, "utf8")
    return source.hasBom ? Buffer.concat([UTF8_BOM, encoded]) : encoded
}

function matchingLineIndexes(
    lines: readonly string[],
    expected: string,
    start: number,
): readonly number[] {
    const matches: number[] = []
    for (let index = start; index < lines.length; index += 1) {
        if (lines[index] === expected) matches.push(index)
        if (matches.length === 2) break
    }
    return matches
}

function matchingSequenceIndexes(
    lines: readonly string[],
    expected: readonly string[],
    start: number,
    atEnd: boolean,
): readonly number[] {
    const finalStart = lines.length - expected.length
    if (atEnd) {
        if (finalStart < start) return []
        for (let offset = 0; offset < expected.length; offset += 1) {
            if (lines[finalStart + offset] !== expected[offset]) return []
        }
        return [finalStart]
    }

    const prefixLengths = new Uint32Array(expected.length)
    for (let index = 1, prefixLength = 0; index < expected.length;) {
        if (expected[index] === expected[prefixLength]) {
            prefixLength += 1
            prefixLengths[index] = prefixLength
            index += 1
        } else if (prefixLength > 0) {
            prefixLength = prefixLengths[prefixLength - 1] ?? 0
        } else index += 1
    }

    const matches: number[] = []
    let matchedLength = 0
    for (let index = start; index < lines.length; index += 1) {
        while (matchedLength > 0 && lines[index] !== expected[matchedLength]) {
            matchedLength = prefixLengths[matchedLength - 1] ?? 0
        }
        if (lines[index] === expected[matchedLength]) matchedLength += 1
        if (matchedLength !== expected.length) continue
        matches.push(index - expected.length + 1)
        if (matches.length === 2) break
        matchedLength = prefixLengths[matchedLength - 1] ?? 0
    }
    return matches
}

function reservePath(paths: Map<string, string>, path: string, operation: string): void {
    const key = pathCollisionKey(path)
    for (const [reservedPath, previous] of paths) {
        if (
            key === reservedPath
            || key.startsWith(`${reservedPath}/`)
            || reservedPath.startsWith(`${key}/`)
        ) {
            throw new Error(
                `Conflicting patch paths resolve to ${quote(path)}: ${previous} and ${operation}`,
            )
        }
    }
    paths.set(key, operation)
}

function includeContentBytes(current: number, additional: number): number {
    if (additional > WORKSPACE_PATCH_MAX_AGGREGATE_BYTES - current) {
        throw new Error("Patch source and final content exceed the 4 MiB aggregate limit")
    }
    return current + additional
}

function affectedPathsFor(changes: readonly IExactChange[]): readonly string[] {
    const paths: string[] = []
    for (const change of changes) {
        if (change.source !== null) paths.push(change.source.path)
        if (
            change.destination !== null
            && change.destination.path !== change.source?.path
        ) paths.push(change.destination.path)
    }
    return paths
}

function renderPlanDiff(changes: readonly IExactChange[]): {
    readonly text: string
    readonly additions: number
    readonly deletions: number
} {
    const parts: string[] = []
    let byteLength = 0
    let additions = 0
    let deletions = 0
    for (const change of changes) {
        const oldPath = change.source?.path ?? null
        const newPath = change.destination?.path ?? null
        const oldText = change.source === null ? "" : decodeExactText(change.source.content)
        const newText = change.destination === null
            ? ""
            : decodeExactText(change.destination.content)
        let rendered: ReturnType<typeof createUnifiedDiff>
        try {
            rendered = createUnifiedDiff({
                oldPath,
                newPath,
                oldText,
                newText,
                maxBytes: WORKSPACE_PATCH_MAX_DIFF_BYTES - byteLength,
            })
        } catch (error) {
            if (!(error instanceof UnifiedDiffTooLargeError)) throw error
            throw new Error(
                "Patch approval diff exceeds the 500 KiB limit. Split the work into smaller "
                + "patches; no workspace files were changed.",
                { cause: error },
            )
        }
        const renderedBytes = Buffer.byteLength(rendered.text, "utf8")
        if (renderedBytes > WORKSPACE_PATCH_MAX_DIFF_BYTES - byteLength) {
            throw new Error(
                "Patch approval diff exceeds the 500 KiB limit. Split the work into smaller "
                + "patches; no workspace files were changed.",
            )
        }
        parts.push(rendered.text)
        byteLength += renderedBytes
        additions += rendered.additions
        deletions += rendered.deletions
    }
    return { text: parts.join(""), additions, deletions }
}

function patchSummary(
    filesChanged: number,
    additions: number,
    deletions: number,
): IWorkspacePatchSummary {
    const fileWord = filesChanged === 1 ? "file" : "files"
    const additionWord = additions === 1 ? "insertion" : "insertions"
    const deletionWord = deletions === 1 ? "deletion" : "deletions"
    return {
        filesChanged,
        additions,
        deletions,
        text: `${filesChanged} ${fileWord} changed, ${additions} ${additionWord}(+), ${deletions} ${deletionWord}(-)`,
    }
}

async function applyInternalPatch(
    patch: IInternalPatchPlan,
    publicPlan: IWorkspacePatchPlan,
    signal: AbortSignal,
): Promise<IWorkspacePatchApplyResult> {
    await revalidatePlan(patch, signal)
    signal.throwIfAborted()

    const stagedWrites: IStagedWrite[] = []
    const createdDirectories: string[] = []
    try {
        const writes = patch.changes
            .filter(isWriteChange)
            .sort((left, right) => compareStrings(left.destination.path, right.destination.path))
        for (const change of writes) {
            signal.throwIfAborted()
            const path = change.destination.path
            const absolutePath = absolutePlanPath(patch.workspaceRoot, path)
            await ensureTargetDirectory(
                patch.workspaceRoot,
                dirname(absolutePath),
                createdDirectories,
                signal,
            )
            const temporaryPath = await stagePrivateFile(
                dirname(absolutePath),
                change.destination.content,
                signal,
            )
            stagedWrites.push({ change, path, absolutePath, temporaryPath })
        }

        signal.throwIfAborted()
        await revalidatePlan(patch, signal)
        signal.throwIfAborted()
    } catch (error) {
        const cleanupErrors = await cleanupPreparation(stagedWrites, createdDirectories)
        if (cleanupErrors.length > 0) {
            throw new WorkspacePatchSideEffectsUnknownError(
                [error, ...cleanupErrors],
                "Workspace patch preparation failed and cleanup was incomplete",
            )
        }
        throw error
    }

    const committedWrites: IStagedWrite[] = []
    const committedDeletions: TDeleteChange[] = []
    // Portable Node APIs cannot bind validation to rename/link/unlink. External parent swaps
    // remain possible, as does the final check-to-mutation gap for replacements and deletions.
    try {
        for (const staged of stagedWrites) {
            const change = staged.change
            const destination = change.destination
            const source = change.source
            await chmod(staged.temporaryPath, destination.mode)
            if (source !== null && source.path === destination.path) {
                await assertSourceCurrent(patch.workspaceRoot, source)
                try {
                    await rename(staged.temporaryPath, staged.absolutePath)
                } catch (error) {
                    throw new Error(`Failed to commit write ${quote(staged.path)}`, { cause: error })
                }
            } else {
                await assertDestinationMissing(patch.workspaceRoot, destination)
                try {
                    // A same-filesystem hard link publishes the staged inode without replacement.
                    await link(staged.temporaryPath, staged.absolutePath)
                } catch (error) {
                    if (errno(error) === "EEXIST") {
                        throw new StaleWorkspacePatchError(
                            `Workspace patch plan is stale at ${quote(staged.path)}: path state changed`,
                            error,
                        )
                    }
                    throw new Error(`Failed to commit write ${quote(staged.path)}`, { cause: error })
                }
            }
            committedWrites.push(staged)
        }

        const deletions = patch.changes
            .filter(isDeleteChange)
            .sort((left, right) => compareStrings(left.source.path, right.source.path))
        for (const change of deletions) {
            const source = change.source
            await assertSourceCurrent(patch.workspaceRoot, source)
            try {
                await unlink(absolutePlanPath(patch.workspaceRoot, source.path))
            } catch (error) {
                throw new Error(`Failed to commit deletion ${quote(source.path)}`, {
                    cause: error,
                })
            }
            committedDeletions.push(change)
        }
    } catch (commitError) {
        const mutationCount = committedWrites.length + committedDeletions.length
        const rollbackErrors = await rollbackCommittedChanges(
            patch.workspaceRoot,
            committedWrites,
            committedDeletions,
        )
        rollbackErrors.push(...await cleanupPreparation(stagedWrites, createdDirectories))
        if (rollbackErrors.length > 0) {
            throw new WorkspacePatchSideEffectsUnknownError(
                [commitError, ...rollbackErrors],
                "Workspace patch commit failed and rollback was incomplete",
            )
        }
        if (mutationCount === 0) throw commitError
        throw new Error(
            "Workspace patch commit failed; committed changes were rolled back",
            { cause: commitError },
        )
    }

    const cleanupErrors = await cleanupTemporaryFiles(stagedWrites)
    const cleanupWarning = cleanupErrors.length === 0
        ? ""
        : `; warning: ${cleanupErrors.length} temporary staging file(s) could not be removed`
    const result: IWorkspacePatchApplyResult = {
        applied: true,
        affectedPaths: [...publicPlan.affectedPaths],
        filesChanged: publicPlan.summary.filesChanged,
        summary: `Applied workspace patch: ${publicPlan.summary.text}${cleanupWarning}`,
    }
    deepFreeze(result)
    if (signal.aborted) {
        const cause = cleanupErrors.length === 0
            ? signal.reason
            : new AggregateError(
                [signal.reason, ...cleanupErrors],
                "Patch committed after cancellation and staging cleanup was incomplete",
            )
        throw new WorkspacePatchCommittedAfterAbortError(result, cause)
    }
    return result
}

async function revalidatePlan(
    patch: IInternalPatchPlan,
    signal: AbortSignal,
): Promise<void> {
    let currentRoot: string
    try {
        currentRoot = await resolveWorkspaceRoot(patch.workspaceRoot, signal)
    } catch (error) {
        if (signal.aborted) signal.throwIfAborted()
        throw new StaleWorkspacePatchError("Workspace patch plan is stale: root changed", error)
    }
    if (currentRoot !== patch.workspaceRoot) {
        throw new StaleWorkspacePatchError("Workspace patch plan is stale: root changed")
    }

    for (const change of patch.changes) {
        signal.throwIfAborted()
        if (change.source !== null) {
            await assertSourceCurrent(currentRoot, change.source, signal)
        }
        if (
            change.destination !== null
            && change.destination.path !== change.source?.path
        ) {
            await assertDestinationMissing(currentRoot, change.destination, signal)
        }
    }
    signal.throwIfAborted()
}

async function assertSourceCurrent(
    root: string,
    source: IExactFileState,
    signal?: AbortSignal,
): Promise<void> {
    let resolvedPath: IResolvedMutationPath
    try {
        resolvedPath = await resolveMutationPath(root, source.requestedPath, signal)
    } catch (error) {
        throwStaleOrAbort(source.path, error, signal)
    }
    if (!resolvedPath.exists || resolvedPath.relativePath !== source.path) {
        throw new StaleWorkspacePatchError(
            `Workspace patch plan is stale at ${quote(source.path)}: path state changed`,
        )
    }

    let current: IFileState
    try {
        current = await readFileState(
            resolvedPath.absolutePath,
            source.requestedPath,
            WORKSPACE_PATCH_MAX_SOURCE_BYTES,
            signal,
        )
    } catch (error) {
        throwStaleOrAbort(source.path, error, signal)
    }
    if (fileRevision(current.bytes) !== source.revision || current.mode !== source.mode) {
        throw new StaleWorkspacePatchError(
            `Workspace patch plan is stale at ${quote(source.path)}: bytes or mode changed`,
        )
    }
}

async function assertDestinationMissing(
    root: string,
    destination: IExactFileState,
    signal?: AbortSignal,
): Promise<void> {
    let resolvedPath: IResolvedMutationPath
    try {
        resolvedPath = await resolveMutationPath(root, destination.requestedPath, signal)
    } catch (error) {
        throwStaleOrAbort(destination.path, error, signal)
    }
    if (resolvedPath.exists || resolvedPath.relativePath !== destination.path) {
        throw new StaleWorkspacePatchError(
            `Workspace patch plan is stale at ${quote(destination.path)}: path state changed`,
        )
    }
}

function throwStaleOrAbort(path: string, error: unknown, signal?: AbortSignal): never {
    if (signal?.aborted) signal.throwIfAborted()
    throw new StaleWorkspacePatchError(
        `Workspace patch plan is stale at ${quote(path)}`,
        error,
    )
}

async function ensureTargetDirectory(
    root: string,
    targetDirectory: string,
    createdDirectories: string[],
    signal: AbortSignal,
): Promise<void> {
    if (!isPathInside(root, targetDirectory)) {
        throw new Error("Patch target directory is outside the workspace")
    }
    const missing: string[] = []
    let current = targetDirectory
    while (true) {
        signal.throwIfAborted()
        try {
            const metadata = await lstat(current)
            signal.throwIfAborted()
            if (!metadata.isDirectory()) {
                throw new Error(`Patch target parent is not a directory: ${quote(current)}`)
            }
            break
        } catch (error) {
            if (!isMissingPathError(error)) throw error
        }
        if (current === root) throw new Error("Workspace root disappeared during patch staging")
        missing.unshift(current)
        current = dirname(current)
    }

    for (const directory of missing) {
        signal.throwIfAborted()
        await mkdir(directory)
        createdDirectories.push(directory)
        signal.throwIfAborted()
    }
    const canonicalDirectory = await realpath(targetDirectory)
    signal.throwIfAborted()
    if (canonicalDirectory !== targetDirectory || !isPathInside(root, canonicalDirectory)) {
        throw new Error("Patch target directory changed through a symlink during staging")
    }
}

async function stagePrivateFile(
    directory: string,
    content: Uint8Array,
    signal?: AbortSignal,
): Promise<string> {
    for (let attempt = 0; attempt < TEMP_FILE_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal)
        const temporaryPath = join(
            directory,
            `.buli-patch-${process.pid}-${randomUUID()}.tmp`,
        )
        let handle: Awaited<ReturnType<typeof open>>
        try {
            handle = await open(temporaryPath, "wx", 0o600)
        } catch (error) {
            if (errno(error) === "EEXIST") continue
            throw error
        }

        let writeError: unknown
        try {
            await handle.writeFile(content)
            await handle.sync()
        } catch (error) {
            writeError = error
        }
        try {
            await handle.close()
        } catch (error) {
            writeError = writeError === undefined
                ? error
                : new AggregateError([writeError, error], "Failed to stage patch content")
        }
        if (writeError !== undefined) {
            try {
                await unlink(temporaryPath)
            } catch (cleanupError) {
                if (errno(cleanupError) !== "ENOENT") {
                    throw new WorkspacePatchSideEffectsUnknownError(
                        [writeError, cleanupError],
                        "Failed to stage and clean patch content",
                    )
                }
            }
            throw writeError
        }
        try {
            throwIfAborted(signal)
        } catch (abortError) {
            try {
                await unlink(temporaryPath)
            } catch (cleanupError) {
                if (errno(cleanupError) !== "ENOENT") {
                    throw new WorkspacePatchSideEffectsUnknownError(
                        [abortError, cleanupError],
                        "Patch staging was aborted and temporary-file cleanup failed",
                    )
                }
            }
            throw abortError
        }
        return temporaryPath
    }
    throw new Error("Could not allocate a private patch staging file")
}

async function rollbackCommittedChanges(
    root: string,
    writes: readonly IStagedWrite[],
    deletions: readonly TDeleteChange[],
): Promise<unknown[]> {
    const errors: unknown[] = []
    for (let index = deletions.length - 1; index >= 0; index -= 1) {
        const change = deletions[index]
        if (!change) continue
        const source = change.source
        try {
            await restoreFile(
                absolutePlanPath(root, source.path),
                source.content,
                source.mode,
                false,
            )
        } catch (error) {
            errors.push(new Error(`Failed to roll back deletion ${quote(source.path)}`, {
                cause: error,
            }))
        }
    }

    for (let index = writes.length - 1; index >= 0; index -= 1) {
        const write = writes[index]
        if (!write) continue
        try {
            const destination = write.change.destination
            const current = await readFileState(
                write.absolutePath,
                write.path,
                WORKSPACE_PATCH_MAX_AGGREGATE_BYTES,
            )
            if (
                fileRevision(current.bytes) !== destination.revision
                || current.mode !== destination.mode
            ) {
                throw new Error("Committed file changed before rollback")
            }
            const source = write.change.source
            if (source !== null && source.path === destination.path) {
                await restoreFile(
                    write.absolutePath,
                    source.content,
                    source.mode,
                    true,
                )
            } else await unlink(write.absolutePath)
        } catch (error) {
            errors.push(new Error(`Failed to roll back write ${quote(write.path)}`, {
                cause: error,
            }))
        }
    }
    return errors
}

async function restoreFile(
    target: string,
    content: Uint8Array,
    mode: number,
    replace: boolean,
): Promise<void> {
    const temporaryPath = await stagePrivateFile(dirname(target), content)
    try {
        await chmod(temporaryPath, mode)
        if (replace) await rename(temporaryPath, target)
        else await link(temporaryPath, target)
    } finally {
        try {
            await unlink(temporaryPath)
        } catch (error) {
            if (errno(error) !== "ENOENT") throw error
        }
    }
}

async function cleanupPreparation(
    stagedWrites: readonly IStagedWrite[],
    createdDirectories: readonly string[],
): Promise<unknown[]> {
    const errors = await cleanupTemporaryFiles(stagedWrites)
    for (let index = createdDirectories.length - 1; index >= 0; index -= 1) {
        const directory = createdDirectories[index]
        if (!directory) continue
        try {
            await rmdir(directory)
        } catch (error) {
            if (errno(error) !== "ENOENT") {
                errors.push(new Error(`Failed to clean patch directory ${quote(directory)}`, {
                    cause: error,
                }))
            }
        }
    }
    return errors
}

async function cleanupTemporaryFiles(
    stagedWrites: readonly IStagedWrite[],
): Promise<unknown[]> {
    const errors: unknown[] = []
    for (const staged of stagedWrites) {
        try {
            await unlink(staged.temporaryPath)
        } catch (error) {
            if (errno(error) !== "ENOENT") {
                errors.push(new Error(`Failed to clean patch staging file for ${quote(staged.path)}`, {
                    cause: error,
                }))
            }
        }
    }
    return errors
}

async function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutationQueue
    let release: (() => void) | undefined
    mutationQueue = new Promise<void>((resolveQueue) => {
        release = resolveQueue
    })
    await previous
    try {
        return await operation()
    } finally {
        release?.()
    }
}

function isWriteChange(change: IExactChange): change is TWriteChange {
    return change.destination !== null
}

function isDeleteChange(change: IExactChange): change is TDeleteChange {
    return change.source !== null && change.source.path !== change.destination?.path
}

function absolutePlanPath(root: string, path: string): string {
    const target = resolve(root, path)
    if (!isPathInside(root, target)) throw new Error("Patch plan path escaped its workspace")
    return target
}

function fileRevision(content: Uint8Array): string {
    const hash = createHash("sha256")
    hash.update("buli-workspace-patch\0file\0", "utf8")
    hash.update(content)
    return `sha256:${hash.digest("hex")}`
}

function decodeExactText(content: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content)
}

function startsWithBom(content: Uint8Array): boolean {
    return content[0] === UTF8_BOM[0]
        && content[1] === UTF8_BOM[1]
        && content[2] === UTF8_BOM[2]
}

function defaultFileMode(): number {
    return 0o666 & ~process.umask()
}

function hasBinarySignature(sample: Uint8Array): boolean {
    const startsWith = (...bytes: number[]): boolean => (
        bytes.every((byte, index) => sample[index] === byte)
    )
    return startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)
        || startsWith(0x89, 0x50, 0x4e, 0x47)
        || startsWith(0xff, 0xd8, 0xff)
        || startsWith(0x47, 0x49, 0x46, 0x38)
        || startsWith(0x50, 0x4b, 0x03, 0x04)
        || startsWith(0x1f, 0x8b)
        || startsWith(0x7f, 0x45, 0x4c, 0x46)
}

function toWorkspaceRelativePath(root: string, target: string): string {
    if (!isPathInside(root, target)) throw new Error("Resolved path is outside the workspace")
    const workspacePath = relative(root, target)
    return workspacePath ? workspacePath.split(sep).join("/") : "."
}

function isPathInside(root: string, target: string): boolean {
    const workspacePath = relative(root, target)
    return workspacePath === "" || (
        workspacePath !== ".."
        && !workspacePath.startsWith(`..${sep}`)
        && !isAbsolute(workspacePath)
    )
}

function hasGitSegment(path: string): boolean {
    return path.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git")
}

function pathCollisionKey(path: string): string {
    const normalized = path.normalize("NFC")
    return process.platform === "darwin" || process.platform === "win32"
        ? normalized.toLowerCase()
        : normalized
}

function isMissingPathError(error: unknown): boolean {
    const code = errno(error)
    return code === "ENOENT" || code === "ENOTDIR"
}

function errno(error: unknown): string | undefined {
    return error instanceof Error && "code" in error ? String(error.code) : undefined
}

function assertSignal(signal: AbortSignal): void {
    if (!signal || typeof signal.throwIfAborted !== "function") {
        throw new TypeError("signal must be an AbortSignal")
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted()
}

function isWellFormed(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index)
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1)
            if (next < 0xdc00 || next > 0xdfff) return false
            index += 1
        } else if (code >= 0xdc00 && code <= 0xdfff) return false
    }
    return true
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length
        && left.every((value, index) => value === right[index])
}

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function quote(value: unknown): string {
    return JSON.stringify(value)
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
