import { Buffer } from "node:buffer"
import { constants as FS_CONSTANTS } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import {
    delimiter as PATH_DELIMITER,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path"

const MAX_STDERR_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const CLEANUP_DEADLINE_MS = 2_000
const CLEANUP_DEADLINE_SAFETY_MS = 100
const TERMINATION_GRACE_MS = 200
const TERMINATION_POLL_MS = 25
const SAFE_WINDOWS_EXTENSIONS = new Set([".com", ".exe"])
const BLOCKED_EXECUTABLE_ENVIRONMENT = new Set([
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
])

export interface IRipgrepResult {
    readonly exitCode: number
    readonly stderr: string
    readonly stoppedEarly: boolean
}

interface IRipgrepOptions {
    readonly executable: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly signal: AbortSignal
    readonly timeoutMs: number
    readonly delimiter: number
    readonly onRecord: (record: string, stop: () => void) => void
}

export interface IRipgrepExecutableResolverOptions {
    readonly executablePath?: string
    readonly searchPath?: string
    readonly pathExt?: string
}

export type TRipgrepExecutableResolver = (
    signal: AbortSignal,
) => Promise<string>

/** Resolves and caches one absolute ripgrep executable outside the workspace. */
export function createRipgrepExecutableResolver(
    workspaceRoot: string,
    options: IRipgrepExecutableResolverOptions = {},
): TRipgrepExecutableResolver {
    const searchPath = options.searchPath ?? process.env.PATH ?? ""
    const pathExt = options.pathExt ?? process.env.PATHEXT
    let resolution: Promise<string> | undefined

    return async (signal) => {
        signal.throwIfAborted()
        resolution ??= options.executablePath === undefined
            ? resolveRipgrepExecutable(workspaceRoot, searchPath, pathExt)
            : validateRipgrepExecutable(options.executablePath)
        try {
            const executable = await resolution
            signal.throwIfAborted()
            return executable
        } catch (error) {
            signal.throwIfAborted()
            throw error
        }
    }
}

async function validateRipgrepExecutable(executablePath: string): Promise<string> {
    if (!isAbsolute(executablePath)) {
        throw new TypeError("ripgrep executable path must be absolute")
    }

    try {
        const executable = await realpath(executablePath)
        const executableStat = await stat(executable)
        if (!executableStat.isFile()) throw new Error("path is not a file")
        if (process.platform !== "win32") {
            await access(executable, FS_CONSTANTS.X_OK)
        }
        return executable
    } catch (error) {
        throw new Error(
            `Cannot use bundled ripgrep executable ${JSON.stringify(executablePath)}: `
            + errorMessage(error),
        )
    }
}

/** Runs ripgrep directly and parses delimited stdout without buffering it whole. */
export async function runRipgrep(
    options: IRipgrepOptions,
): Promise<IRipgrepResult> {
    options.signal.throwIfAborted()
    if (!isAbsolute(options.executable)) {
        throw new TypeError("ripgrep executable must be an absolute path")
    }

    const child = spawnRipgrep(options.executable, options.args, options.cwd)
    type TTerminationCause = "abort" | "failure" | "stop" | "timeout"
    let terminationCause: TTerminationCause | undefined
    let terminationPromise: Promise<boolean> | undefined
    let cleanupDeadline: IDeadline | undefined
    let acceptingRecords = true
    let stoppedEarly = false
    let notifyTerminationRequested: () => void = () => {}
    const terminationRequested = new Promise<void>((resolveRequested) => {
        notifyTerminationRequested = resolveRequested
    })
    const requestTermination = (cause: TTerminationCause): Promise<boolean> => {
        if (terminationCause === undefined) {
            terminationCause = cause
            acceptingRecords = false
            cleanupDeadline = createDeadline(CLEANUP_DEADLINE_MS)
            const terminationDeadline = Math.max(
                Date.now(),
                cleanupDeadline.endsAt - CLEANUP_DEADLINE_SAFETY_MS,
            )
            terminationPromise = terminateProcessTree(child, terminationDeadline)
                .catch(() => false)
            notifyTerminationRequested()
        }
        return terminationPromise!
    }
    const stop = (): void => {
        if (stoppedEarly) return
        stoppedEarly = true
        void requestTermination("stop")
    }
    const abort = (): void => {
        void requestTermination("abort")
    }

    const stdoutDrain = startRecordDrain(
        child.stdout,
        options.delimiter,
        (record) => {
            if (acceptingRecords) options.onRecord(record, stop)
        },
    )
    const stderrDrain = startBoundedTextDrain(child.stderr, MAX_STDERR_BYTES)
    let stdoutFailure: { readonly reason: unknown } | undefined
    let stderrFailure: { readonly reason: unknown } | undefined
    const stdoutFinished = stdoutDrain.finished.catch((error: unknown) => {
        stdoutFailure = { reason: error }
        if (!stoppedEarly) void requestTermination("failure")
        throw error
    })
    const stderrFinished = stderrDrain.finished.catch((error: unknown) => {
        stderrFailure = { reason: error }
        void requestTermination("failure")
        throw error
    })
    const completionPromise = Promise.allSettled([
        stdoutFinished,
        stderrFinished,
        child.exited,
    ] as const)

    options.signal.addEventListener("abort", abort, { once: true })
    if (options.signal.aborted) abort()
    const timeout = setTimeout(() => {
        if (terminationCause === undefined) void requestTermination("timeout")
    }, options.timeoutMs)

    let completion: Awaited<typeof completionPromise> | undefined
    let cleanupConfirmed = true
    try {
        const firstOutcome = await Promise.race([
            completionPromise.then((value) => ({
                kind: "completed" as const,
                value,
            })),
            terminationRequested.then(() => ({ kind: "termination" as const })),
        ])

        if (firstOutcome.kind === "completed" && terminationCause === undefined) {
            completion = firstOutcome.value
        } else {
            const activeDeadline = cleanupDeadline
            const activeTermination = terminationPromise
            if (!activeDeadline || !activeTermination) {
                throw new Error("ripgrep cleanup did not initialize")
            }

            const cleanupOutcome = await Promise.race([
                Promise.all([completionPromise, activeTermination] as const).then(
                    (value) => ({ kind: "completed" as const, value }),
                ),
                activeDeadline.elapsed.then(() => ({ kind: "deadline" as const })),
            ])
            if (cleanupOutcome.kind === "completed") {
                completion = cleanupOutcome.value[0]
                cleanupConfirmed = cleanupOutcome.value[1]
            } else {
                cleanupConfirmed = false
                forceTerminateProcessTree(child)
                stdoutDrain.stop()
                stderrDrain.stop()
                try {
                    child.unref()
                } catch {
                    // The process may already have been released by Bun.
                }
            }
        }
    } finally {
        clearTimeout(timeout)
        cleanupDeadline?.clear()
        options.signal.removeEventListener("abort", abort)
    }

    if (!cleanupConfirmed) {
        throw new Error("ripgrep process cleanup could not be confirmed")
    }
    if (terminationCause === "abort") {
        options.signal.throwIfAborted()
        throw options.signal.reason
    }
    if (terminationCause === "timeout") {
        throw new Error(`ripgrep timed out after ${options.timeoutMs} ms`)
    }
    options.signal.throwIfAborted()

    if (completion) {
        const [stdoutResult, stderrResult, exitResult] = completion
        if (exitResult.status === "rejected") {
            throw ripgrepStartError(exitResult.reason)
        }
        if (stdoutResult.status === "rejected" && !stoppedEarly) {
            throw outputReadError("output", stdoutResult.reason)
        }
        if (stderrResult.status === "rejected") {
            throw outputReadError("errors", stderrResult.reason)
        }
        return {
            exitCode: exitResult.value,
            stderr: stderrDrain.text(),
            stoppedEarly,
        }
    }

    if (stdoutFailure && !stoppedEarly) {
        throw outputReadError("output", stdoutFailure.reason)
    }
    if (stderrFailure) throw outputReadError("errors", stderrFailure.reason)
    if (!stoppedEarly) throw new Error("ripgrep did not finish before its cleanup deadline")
    return {
        exitCode: typeof child.exitCode === "number" ? child.exitCode : -1,
        stderr: stderrDrain.text(),
        stoppedEarly: true,
    }
}

async function resolveRipgrepExecutable(
    workspaceRoot: string,
    searchPath: string,
    pathExt: string | undefined,
): Promise<string> {
    let canonicalWorkspace: string
    try {
        canonicalWorkspace = await realpath(resolve(workspaceRoot))
    } catch (error) {
        throw new Error(
            `Cannot resolve workspace root while locating ripgrep: ${errorMessage(error)}`,
        )
    }

    const candidateNames = process.platform === "win32"
        ? windowsCandidateNames(pathExt)
        : ["rg"]
    for (const pathEntry of searchPath.split(PATH_DELIMITER)) {
        if (!pathEntry || !isAbsolute(pathEntry)) continue

        let directory: string
        try {
            directory = await realpath(pathEntry)
            const directoryStat = await stat(directory)
            if (!directoryStat.isDirectory()) continue
        } catch {
            continue
        }
        if (isPathInside(canonicalWorkspace, directory)) continue

        for (const candidateName of candidateNames) {
            let candidate: string
            try {
                candidate = await realpath(join(directory, candidateName))
                if (isPathInside(canonicalWorkspace, candidate)) continue
                const candidateStat = await stat(candidate)
                if (!candidateStat.isFile()) continue
                if (process.platform !== "win32") {
                    await access(candidate, FS_CONSTANTS.X_OK)
                }
            } catch {
                continue
            }
            return candidate
        }
    }

    throw new Error("ripgrep is required but no safe executable was found on PATH")
}

function windowsCandidateNames(pathExt: string | undefined): string[] {
    const configured = pathExt ?? ".COM;.EXE"
    const extensions: string[] = []
    const seen = new Set<string>()
    for (const value of configured.split(";")) {
        const extension = value.trim().toLowerCase()
        if (!SAFE_WINDOWS_EXTENSIONS.has(extension) || seen.has(extension)) continue
        seen.add(extension)
        extensions.push(extension)
    }
    return extensions.map((extension) => `rg${extension}`)
}

interface IOutputDrain {
    readonly finished: Promise<void>
    readonly stop: () => void
}

function startRecordDrain(
    stream: ReadableStream<Uint8Array>,
    delimiter: number,
    onRecord: (record: string) => void,
): IOutputDrain {
    const reader = stream.getReader()
    let stopped = false
    let settled = false
    let chunks: Uint8Array[] = []
    let recordBytes = 0

    const append = (chunk: Uint8Array): void => {
        if (recordBytes + chunk.byteLength > MAX_RECORD_BYTES) {
            throw new Error("ripgrep produced an oversized output record")
        }
        if (chunk.byteLength > 0) chunks.push(chunk)
        recordBytes += chunk.byteLength
    }
    const emit = (): void => {
        const record = chunks.length === 1
            ? new TextDecoder().decode(chunks[0])
            : Buffer.concat(chunks, recordBytes).toString("utf8")
        chunks = []
        recordBytes = 0
        onRecord(record)
    }
    const finished = (async (): Promise<void> => {
        try {
            while (!stopped) {
                const item = await reader.read()
                if (stopped || item.done) break

                let start = 0
                for (let index = 0; index < item.value.byteLength; index += 1) {
                    if (item.value[index] !== delimiter) continue
                    append(item.value.subarray(start, index))
                    emit()
                    start = index + 1
                }
                append(item.value.subarray(start))
            }
            if (!stopped && recordBytes > 0) emit()
        } catch (error) {
            if (!stopped) throw error
        } finally {
            settled = true
            reader.releaseLock()
        }
    })()

    return {
        finished,
        stop: (): void => {
            if (stopped || settled) return
            stopped = true
            try {
                void reader.cancel().catch(() => {})
            } catch {
                // A concurrently completed stream no longer needs cancellation.
            }
        },
    }
}

interface ITextDrain extends IOutputDrain {
    readonly text: () => string
}

function startBoundedTextDrain(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number,
): ITextDrain {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let retainedBytes = 0
    let truncated = false
    let stopped = false
    let settled = false
    const finished = (async (): Promise<void> => {
        try {
            while (!stopped) {
                const item = await reader.read()
                if (stopped || item.done) break
                const available = maxBytes - retainedBytes
                if (available > 0) {
                    const retained = item.value.subarray(0, available)
                    chunks.push(retained)
                    retainedBytes += retained.byteLength
                }
                if (item.value.byteLength > available) truncated = true
            }
        } catch (error) {
            if (!stopped) throw error
        } finally {
            settled = true
            reader.releaseLock()
        }
    })()

    return {
        finished,
        stop: (): void => {
            if (stopped || settled) return
            stopped = true
            try {
                void reader.cancel().catch(() => {})
            } catch {
                // A concurrently completed stream no longer needs cancellation.
            }
        },
        text: (): string => {
            const output = Buffer.concat(chunks, retainedBytes).toString("utf8").trim()
            return truncated
                ? `${output}\n... ripgrep stderr truncated`.trim()
                : output
        },
    }
}

function spawnRipgrep(
    executable: string,
    args: readonly string[],
    cwd: string,
) {
    try {
        return Bun.spawn([executable, ...args], {
            cwd,
            detached: process.platform !== "win32",
            env: sanitizedExecutableEnvironment(),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
        })
    } catch (error) {
        throw ripgrepStartError(error)
    }
}

function sanitizedExecutableEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (
            value === undefined
            || BLOCKED_EXECUTABLE_ENVIRONMENT.has(key)
            || key.startsWith("DYLD_")
        ) {
            continue
        }
        environment[key] = value
    }
    return environment
}

type TRipgrepProcess = ReturnType<typeof spawnRipgrep>

async function terminateProcessTree(
    child: TRipgrepProcess,
    deadlineAt: number,
): Promise<boolean> {
    if (process.platform === "win32") {
        signalDirectChild(child, "SIGTERM")
        const graceDeadline = Math.min(deadlineAt, Date.now() + TERMINATION_GRACE_MS)
        if (await waitForDirectChildExit(child, graceDeadline)) return true
        signalDirectChild(child, "SIGKILL")
        return await waitForDirectChildExit(child, deadlineAt)
    }

    signalPosixProcessTree(child, "SIGTERM")
    const graceDeadline = Math.min(deadlineAt, Date.now() + TERMINATION_GRACE_MS)
    if (await waitForPosixProcessTreeExit(child.pid, graceDeadline)) return true
    signalPosixProcessTree(child, "SIGKILL")
    return await waitForPosixProcessTreeExit(child.pid, deadlineAt)
}

function forceTerminateProcessTree(child: TRipgrepProcess): void {
    if (process.platform === "win32") {
        signalDirectChild(child, "SIGKILL")
        return
    }
    signalPosixProcessTree(child, "SIGKILL")
}

function signalPosixProcessTree(
    child: TRipgrepProcess,
    signal: "SIGKILL" | "SIGTERM",
): void {
    try {
        process.kill(-child.pid, signal)
        return
    } catch {
        // Fall back if the group exited or could not be created.
    }
    signalDirectChild(child, signal)
}

function signalDirectChild(
    child: TRipgrepProcess,
    signal: "SIGKILL" | "SIGTERM",
): void {
    try {
        child.kill(signal)
    } catch {
        // The process may already have exited.
    }
}

async function waitForPosixProcessTreeExit(
    pid: number,
    deadlineAt: number,
): Promise<boolean> {
    while (true) {
        if (!posixProcessGroupExists(pid)) return true
        const remainingMs = deadlineAt - Date.now()
        if (remainingMs <= 0) return false
        await delay(Math.min(TERMINATION_POLL_MS, remainingMs))
    }
}

function posixProcessGroupExists(pid: number): boolean {
    try {
        process.kill(-pid, 0)
        return true
    } catch (error) {
        return errno(error) !== "ESRCH"
    }
}

async function waitForDirectChildExit(
    child: TRipgrepProcess,
    deadlineAt: number,
): Promise<boolean> {
    while (child.exitCode === null) {
        const remainingMs = deadlineAt - Date.now()
        if (remainingMs <= 0) return false
        await delay(Math.min(TERMINATION_POLL_MS, remainingMs))
    }
    return true
}

interface IDeadline {
    readonly endsAt: number
    readonly elapsed: Promise<void>
    readonly clear: () => void
}

function createDeadline(durationMs: number): IDeadline {
    const endsAt = Date.now() + durationMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const elapsed = new Promise<void>((resolveElapsed) => {
        timer = setTimeout(() => {
            timer = undefined
            resolveElapsed()
        }, durationMs)
    })
    return {
        endsAt,
        elapsed,
        clear: (): void => {
            if (timer === undefined) return
            clearTimeout(timer)
            timer = undefined
        },
    }
}

async function delay(durationMs: number): Promise<void> {
    await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, durationMs)
    })
}

function isPathInside(root: string, target: string): boolean {
    const path = relative(root, target)
    return path === "" || (
        path !== ".."
        && !path.startsWith(`..${sep}`)
        && !isAbsolute(path)
    )
}

function outputReadError(stream: "errors" | "output", error: unknown): Error {
    return new Error(`Cannot read ripgrep ${stream}: ${errorMessage(error)}`)
}

function ripgrepStartError(error: unknown): Error {
    return new Error(
        `ripgrep is required but could not be started: ${errorMessage(error)}`,
    )
}

function errno(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? String(error.code)
        : undefined
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
