import { constants as FS_CONSTANTS } from "node:fs"
import { access, stat } from "node:fs/promises"

const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const MAX_PROGRESS_TAIL_BYTES = 256 * 1024
const CLEANUP_DEADLINE_MS = 2_000
const CLEANUP_DEADLINE_SAFETY_MS = 100
const TERMINATION_GRACE_MS = 200
const TERMINATION_POLL_MS = 25
const STDOUT_TRUNCATION_MARKER = "... [stdout truncated]"
const STDERR_TRUNCATION_MARKER = "... [stderr truncated]"

export const PROCESS_TIMEOUT_EXIT_CODE = 124
export const PROCESS_PROGRESS_EVENT_LIMIT = 64
export const PROCESS_CLEANUP_WARNING = "Process tree cleanup could not be confirmed"
export const PROCESS_INTERPRETER_DISPLAY = process.platform === "win32"
    ? "Bash unavailable on Windows in v1"
    : "/bin/bash --noprofile --norc -c"

const BLOCKED_BASH_ENVIRONMENT = new Set([
    "BASH_ENV",
    "BASHOPTS",
    "CDPATH",
    "ENV",
    "GLOBIGNORE",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "BASH_XTRACEFD",
    "PS0",
    "PS4",
    "SHELLOPTS",
])

export interface IProcessOutputLimits {
    /** Maximum source bytes retained from stdout, excluding a fixed marker. */
    readonly stdoutBytes: number
    /** Maximum source bytes retained from stderr, excluding a fixed marker. */
    readonly stderrBytes: number
    /** Maximum recent source bytes exposed per stream in a progress event. */
    readonly progressTailBytes: number
}

export interface IProcessProgress {
    readonly stream: "stdout" | "stderr"
    readonly tail: string
    readonly truncated: boolean
}

export interface IProcessRunnerOptions {
    readonly command: string
    readonly cwd: string
    readonly signal: AbortSignal
    readonly timeoutMs?: number
    readonly outputLimits: IProcessOutputLimits
    readonly onProgress?: (progress: IProcessProgress) => void
    readonly onOutputChunk?: (
        stream: "stdout" | "stderr",
        chunk: Uint8Array,
    ) => void | Promise<void>
}

export interface IProcessRunnerResult {
    /** The process exit code, or 124 when timedOut is true. */
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
    readonly stdoutTruncated: boolean
    readonly stderrTruncated: boolean
    /** True when the complete inline stdout required replacement decoding. */
    readonly stdoutInvalidUtf8: boolean
    /** True when the complete inline stderr required replacement decoding. */
    readonly stderrInvalidUtf8: boolean
    readonly durationMs: number
    readonly timedOut: boolean
    /** Present when process-tree termination could not be verified. */
    readonly cleanupWarning?: string
}

/** Reports a post-start process failure whose side effects cannot be determined. */
export class ProcessSideEffectsUnknownError extends Error {
    readonly sideEffectsUnknown = true
    readonly cleanupWarning: string | undefined

    constructor(message: string, cause?: unknown, cleanupWarning?: string) {
        const cleanupDetails = cleanupWarning === undefined
            ? ""
            : ` ${cleanupWarning}.`
        super(
            `${message}${cleanupDetails}`,
            { cause },
        )
        this.name = "ProcessSideEffectsUnknownError"
        this.cleanupWarning = cleanupWarning
    }
}

/** Reports an aborted process whose already-started side effects may remain. */
export class ProcessSideEffectsUnknownAfterAbortError
    extends ProcessSideEffectsUnknownError {
    constructor(reason: unknown, cleanupWarning?: string) {
        const message = reason instanceof Error
            ? reason.message
            : typeof reason === "string" ? reason : "Bash command was aborted"
        super(
            `Bash command was aborted after it started; side effects may have occurred: ${message}.`,
            reason,
            cleanupWarning,
        )
        this.name = "ProcessSideEffectsUnknownAfterAbortError"
    }
}

/** Runs one command in a fresh, non-interactive Bash process. */
export async function runShellProcess(
    options: IProcessRunnerOptions,
): Promise<IProcessRunnerResult> {
    validateOptions(options)
    options.signal.throwIfAborted()
    await validateWorkingDirectory(options.cwd, options.signal)
    options.signal.throwIfAborted()

    const shellCommand = await selectShellCommand(options.command, options.signal)
    options.signal.throwIfAborted()

    const progressTailBytes = options.onProgress
        ? options.outputLimits.progressTailBytes
        : 0
    const stdout = new BoundedOutput(
        options.outputLimits.stdoutBytes,
        progressTailBytes,
    )
    const stderr = new BoundedOutput(
        options.outputLimits.stderrBytes,
        progressTailBytes,
    )
    const startedAt = performance.now()
    const child = spawnShellProcess(shellCommand, options.cwd)

    type TTerminationCause = "abort" | "failure" | "timeout"
    let terminationCause: TTerminationCause | undefined
    let timedOut = false
    let terminationPromise: Promise<ITerminationResult> | undefined
    let cleanupDeadline: IDeadline | undefined
    let notifyTerminationRequested: () => void = () => {}
    const terminationRequested = new Promise<void>((resolve) => {
        notifyTerminationRequested = resolve
    })
    const requestTermination = (
        cause: TTerminationCause,
    ): Promise<ITerminationResult> => {
        if (terminationCause === undefined) {
            terminationCause = cause
            timedOut = cause === "timeout"
            cleanupDeadline = createDeadline(CLEANUP_DEADLINE_MS)
            const terminationDeadline = Math.max(
                Date.now(),
                cleanupDeadline.endsAt - CLEANUP_DEADLINE_SAFETY_MS,
            )
            terminationPromise = terminateProcessTree(child, terminationDeadline)
                .catch(() => ({ confirmed: false }))
            notifyTerminationRequested()
        }
        return terminationPromise!
    }
    const abort = (): void => {
        void requestTermination("abort")
    }

    options.signal.addEventListener("abort", abort, { once: true })
    if (options.signal.aborted) abort()

    const timeout = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (terminationCause === undefined) void requestTermination("timeout")
        }, options.timeoutMs)

    const onProgress = options.onProgress
    let progressEventCount = 0
    const reportProgress = onProgress === undefined
        ? undefined
        : (stream: "stdout" | "stderr", output: BoundedOutput): void => {
            if (
                options.signal.aborted
                || terminationCause !== undefined
                || progressEventCount >= PROCESS_PROGRESS_EVENT_LIMIT
            ) {
                return
            }
            progressEventCount += 1
            onProgress(output.progress(stream))
        }
    const stdoutDrain = startOutputDrain(
        child.stdout,
        "stdout",
        stdout,
        reportProgress,
        options.onOutputChunk,
    )
    const stderrDrain = startOutputDrain(
        child.stderr,
        "stderr",
        stderr,
        reportProgress,
        options.onOutputChunk,
    )
    const stdoutFinished = stdoutDrain.finished.catch((error: unknown) => {
        void requestTermination("failure")
        throw error
    })
    const stderrFinished = stderrDrain.finished.catch((error: unknown) => {
        void requestTermination("failure")
        throw error
    })
    const completionPromise = Promise.allSettled([
        child.exited,
        stdoutFinished,
        stderrFinished,
    ] as const)

    let completion: Awaited<typeof completionPromise> | undefined
    let cleanupWarning: string | undefined
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
            if (timeout !== undefined) clearTimeout(timeout)
            if (
                process.platform !== "win32"
                && posixProcessGroupExists(child.pid)
            ) {
                const cleanup = await terminateProcessTree(
                    child,
                    Date.now() + CLEANUP_DEADLINE_MS,
                ).catch(() => ({ confirmed: false }))
                if (!cleanup.confirmed) cleanupWarning = PROCESS_CLEANUP_WARNING
            }
        } else {
            const activeDeadline = cleanupDeadline
            const activeTermination = terminationPromise
            if (!activeDeadline || !activeTermination) {
                throw new Error("Process cleanup did not initialize")
            }

            const cleanupOutcome = await Promise.race([
                Promise.all([completionPromise, activeTermination]).then((value) => ({
                    kind: "completed" as const,
                    value,
                })),
                activeDeadline.elapsed.then(() => ({ kind: "deadline" as const })),
            ])
            if (cleanupOutcome.kind === "completed") {
                completion = cleanupOutcome.value[0]
                if (!cleanupOutcome.value[1].confirmed) {
                    cleanupWarning = PROCESS_CLEANUP_WARNING
                }
            } else {
                cleanupWarning = PROCESS_CLEANUP_WARNING
                forceTerminateProcessTree(child)
                stdoutDrain.stop()
                stderrDrain.stop()
                try {
                    child.unref()
                } catch {
                    // The child may already have been released by Bun.
                }
            }
        }
    } finally {
        if (timeout !== undefined) clearTimeout(timeout)
        cleanupDeadline?.clear()
        options.signal.removeEventListener("abort", abort)
    }

    if (options.signal.aborted) {
        throw new ProcessSideEffectsUnknownAfterAbortError(
            options.signal.reason,
            cleanupWarning,
        )
    }

    const result = (exitCode: number): IProcessRunnerResult => ({
        exitCode,
        stdout: stdout.text(STDOUT_TRUNCATION_MARKER),
        stderr: stderr.text(STDERR_TRUNCATION_MARKER),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutInvalidUtf8: stdout.hasInvalidUtf8(),
        stderrInvalidUtf8: stderr.hasInvalidUtf8(),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        timedOut,
        ...(cleanupWarning === undefined ? {} : { cleanupWarning }),
    })

    if (timedOut) return result(PROCESS_TIMEOUT_EXIT_CODE)
    if (!completion) {
        throw processFailureAfterStart(
            new Error(cleanupWarning ?? "Shell process did not finish"),
            cleanupWarning,
        )
    }

    const [exitResult, stdoutResult, stderrResult] = completion
    if (exitResult.status === "rejected") {
        throw processFailureAfterStart(new Error(
            `Shell process failed before reporting an exit code: ${errorMessage(exitResult.reason)}`,
        ), cleanupWarning)
    }
    if (stdoutResult.status === "rejected") {
        throw processFailureAfterStart(
            outputReadError("stdout", stdoutResult.reason),
            cleanupWarning,
        )
    }
    if (stderrResult.status === "rejected") {
        throw processFailureAfterStart(
            outputReadError("stderr", stderrResult.reason),
            cleanupWarning,
        )
    }
    return result(exitResult.value)
}

class BoundedOutput {
    readonly #captured: Uint8Array
    readonly #tail: Uint8Array
    #capturedBytes = 0
    #tailBytes = 0
    #tailTruncated = false
    truncated = false

    constructor(captureBytes: number, progressTailBytes: number) {
        this.#captured = new Uint8Array(captureBytes)
        this.#tail = new Uint8Array(progressTailBytes)
    }

    append(value: Uint8Array): void {
        if (value.byteLength === 0) return

        const available = this.#captured.byteLength - this.#capturedBytes
        const retained = Math.min(available, value.byteLength)
        if (retained > 0) {
            this.#captured.set(value.subarray(0, retained), this.#capturedBytes)
            this.#capturedBytes += retained
        }
        if (retained < value.byteLength) this.truncated = true

        const tailLimit = this.#tail.byteLength
        if (tailLimit === 0) {
            this.#tailTruncated = true
            return
        }
        if (value.byteLength >= tailLimit) {
            if (this.#tailBytes > 0 || value.byteLength > tailLimit) {
                this.#tailTruncated = true
            }
            this.#tail.set(value.subarray(value.byteLength - tailLimit))
            this.#tailBytes = tailLimit
            return
        }

        const overflow = this.#tailBytes + value.byteLength - tailLimit
        if (overflow > 0) {
            this.#tail.copyWithin(0, overflow, this.#tailBytes)
            this.#tailBytes -= overflow
            this.#tailTruncated = true
        }
        this.#tail.set(value, this.#tailBytes)
        this.#tailBytes += value.byteLength
    }

    progress(stream: "stdout" | "stderr"): IProcessProgress {
        return {
            stream,
            tail: decodeUtf8Tail(this.#tail.subarray(0, this.#tailBytes)),
            truncated: this.#tailTruncated,
        }
    }

    text(marker: string): string {
        const bytes = this.#captured.subarray(0, this.#capturedBytes)
        const text = decodeUtf8Prefix(bytes, this.truncated)
        if (!this.truncated) return text
        return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${marker}`
    }

    hasInvalidUtf8(): boolean {
        const bytes = this.#captured.subarray(0, this.#capturedBytes)
        try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
                // A truncated byte prefix may legitimately end inside one code point.
                stream: this.truncated,
            })
            return false
        } catch {
            return true
        }
    }
}

interface IOutputDrain {
    readonly finished: Promise<void>
    readonly stop: () => void
}

function startOutputDrain(
    stream: ReadableStream<Uint8Array>,
    name: "stdout" | "stderr",
    output: BoundedOutput,
    onProgress?: (
        stream: "stdout" | "stderr",
        output: BoundedOutput,
    ) => void,
    onOutputChunk?: (
        stream: "stdout" | "stderr",
        chunk: Uint8Array,
    ) => void | Promise<void>,
): IOutputDrain {
    const reader = stream.getReader()
    let stopped = false
    let settled = false
    const finished = (async (): Promise<void> => {
        try {
            while (!stopped) {
                const item = await reader.read()
                if (stopped || item.done) return
                output.append(item.value)
                if (onOutputChunk && item.value.byteLength > 0) {
                    try {
                        await onOutputChunk(name, item.value)
                    } catch (error) {
                        throw new Error(
                            `Process output storage callback failed: ${errorMessage(error)}`,
                        )
                    }
                }
                if (!onProgress || item.value.byteLength === 0) continue
                try {
                    onProgress(name, output)
                } catch (error) {
                    throw new Error(
                        `Process progress callback failed: ${errorMessage(error)}`,
                    )
                }
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
    }
}

function decodeUtf8Prefix(bytes: Uint8Array, truncated: boolean): string {
    const decoder = new TextDecoder("utf-8")
    // Streaming mode leaves a code point cut by the byte limit out of the result.
    return decoder.decode(bytes, { stream: truncated })
}

function decodeUtf8Tail(bytes: Uint8Array): string {
    let start = 0
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
        start += 1
    }
    const decoder = new TextDecoder("utf-8")
    return decoder.decode(bytes.subarray(start), { stream: true })
}

async function selectShellCommand(
    command: string,
    signal: AbortSignal,
): Promise<string[]> {
    let executable: string
    if (process.platform === "win32") {
        throw new Error(
            "Bash execution is unavailable on Windows in v1 because Buli cannot pin a trusted bash.exe yet",
        )
    } else {
        executable = "/bin/bash"
    }

    await validateExecutable(executable, signal)
    return [executable, "--noprofile", "--norc", "-c", command]
}

async function validateExecutable(
    executable: string,
    signal: AbortSignal,
): Promise<void> {
    let executableStat
    try {
        executableStat = await stat(executable)
    } catch (error) {
        signal.throwIfAborted()
        throw new Error(
            `Bash is unavailable: cannot access ${JSON.stringify(executable)}: `
                + errorMessage(error),
        )
    }
    signal.throwIfAborted()
    if (!executableStat.isFile()) {
        throw new Error(
            `Bash is unavailable: ${JSON.stringify(executable)} is not a file`,
        )
    }
    try {
        await access(executable, FS_CONSTANTS.X_OK)
    } catch (error) {
        signal.throwIfAborted()
        throw new Error(
            `Bash is unavailable: ${JSON.stringify(executable)} is not executable: `
                + errorMessage(error),
        )
    }
    signal.throwIfAborted()
}

function spawnShellProcess(command: string[], cwd: string) {
    try {
        return Bun.spawn(command, {
            cwd,
            detached: process.platform !== "win32",
            env: sanitizedBashEnvironment(),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
        })
    } catch (error) {
        throw new Error(
            `Cannot start Bash process ${JSON.stringify(command[0])}: ${errorMessage(error)}`,
        )
    }
}

function sanitizedBashEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (
            value === undefined
            || BLOCKED_BASH_ENVIRONMENT.has(key)
            || key.startsWith("BASH_FUNC_")
            || key.startsWith("DYLD_")
        ) {
            continue
        }
        environment[key] = value
    }
    return environment
}

type TShellProcess = ReturnType<typeof spawnShellProcess>

interface ITerminationResult {
    readonly confirmed: boolean
}

async function terminateProcessTree(
    child: TShellProcess,
    deadlineAt: number,
): Promise<ITerminationResult> {
    if (process.platform === "win32") {
        return await terminateWindowsProcessTree(child, deadlineAt)
    }
    return await terminatePosixProcessTree(child, deadlineAt)
}

async function terminatePosixProcessTree(
    child: TShellProcess,
    deadlineAt: number,
): Promise<ITerminationResult> {
    signalPosixProcessTree(child, "SIGTERM")
    const graceDeadline = Math.min(
        deadlineAt,
        Date.now() + TERMINATION_GRACE_MS,
    )
    if (await waitForPosixProcessTreeExit(child, graceDeadline)) {
        return { confirmed: true }
    }

    signalPosixProcessTree(child, "SIGKILL")
    return {
        confirmed: await waitForPosixProcessTreeExit(child, deadlineAt),
    }
}

function signalPosixProcessTree(
    child: TShellProcess,
    signal: "SIGKILL" | "SIGTERM",
): void {
    try {
        process.kill(-child.pid, signal)
        return
    } catch {
        // Fall through when the group has exited or could not be created.
    }
    try {
        child.kill(signal)
    } catch {
        // The direct process may already have exited.
    }
}

async function waitForPosixProcessTreeExit(
    child: TShellProcess,
    deadlineAt: number,
): Promise<boolean> {
    while (true) {
        // The detached child's PID is its process-group ID, so ESRCH confirms
        // that neither the shell nor any same-group descendant remains.
        if (!posixProcessGroupExists(child.pid)) return true
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

async function terminateWindowsProcessTree(
    child: TShellProcess,
    deadlineAt: number,
): Promise<ITerminationResult> {
    const taskkillExecutable = Bun.which("taskkill.exe")
    if (!taskkillExecutable) {
        killDirectChild(child)
        return { confirmed: false }
    }

    let taskkill: ReturnType<typeof Bun.spawn>
    try {
        taskkill = Bun.spawn([
            taskkillExecutable,
            "/PID",
            String(child.pid),
            "/T",
            "/F",
        ], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
        })
    } catch {
        killDirectChild(child)
        return { confirmed: false }
    }

    const taskkillResult = await settleBeforeDeadline(taskkill.exited, deadlineAt)
    if (taskkillResult.kind === "deadline") {
        try {
            taskkill.kill()
            taskkill.unref()
        } catch {
            // The taskkill process may have exited at the deadline.
        }
        killDirectChild(child)
        return { confirmed: false }
    }
    if (taskkillResult.kind === "rejected" || taskkillResult.value !== 0) {
        killDirectChild(child)
        return { confirmed: false }
    }

    return {
        confirmed: await waitForDirectChildExit(child, deadlineAt),
    }
}

function forceTerminateProcessTree(child: TShellProcess): void {
    if (process.platform !== "win32") {
        signalPosixProcessTree(child, "SIGKILL")
        return
    }
    killDirectChild(child)
}

function killDirectChild(child: TShellProcess): void {
    try {
        child.kill("SIGKILL")
    } catch {
        // The direct process may already have exited.
    }
}

async function waitForDirectChildExit(
    child: TShellProcess,
    deadlineAt: number,
): Promise<boolean> {
    while (child.exitCode === null) {
        const remainingMs = deadlineAt - Date.now()
        if (remainingMs <= 0) return false
        await delay(Math.min(TERMINATION_POLL_MS, remainingMs))
    }
    return true
}

type TSettledBeforeDeadline<T> =
    | { readonly kind: "fulfilled"; readonly value: T }
    | { readonly kind: "rejected"; readonly reason: unknown }
    | { readonly kind: "deadline" }

async function settleBeforeDeadline<T>(
    promise: Promise<T>,
    deadlineAt: number,
): Promise<TSettledBeforeDeadline<T>> {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) return { kind: "deadline" }

    const deadline = createDeadline(remainingMs)
    try {
        return await Promise.race([
            promise.then(
                (value): TSettledBeforeDeadline<T> => ({
                    kind: "fulfilled",
                    value,
                }),
                (reason: unknown): TSettledBeforeDeadline<T> => ({
                    kind: "rejected",
                    reason,
                }),
            ),
            deadline.elapsed.then(
                (): TSettledBeforeDeadline<T> => ({ kind: "deadline" }),
            ),
        ])
    } finally {
        deadline.clear()
    }
}

interface IDeadline {
    readonly endsAt: number
    readonly elapsed: Promise<void>
    readonly clear: () => void
}

function createDeadline(durationMs: number): IDeadline {
    const endsAt = Date.now() + durationMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const elapsed = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            timer = undefined
            resolve()
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
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            clearTimeout(timer)
            resolve()
        }, durationMs)
    })
}

function validateOptions(options: IProcessRunnerOptions): void {
    if (!isRecord(options)) {
        throw new TypeError("Process options must be an object")
    }
    if (typeof options.command !== "string" || options.command.trim().length === 0) {
        throw new TypeError("Process command must be a nonempty string")
    }
    if (options.command.includes("\0")) {
        throw new TypeError("Process command cannot contain a NUL byte")
    }
    if (typeof options.cwd !== "string" || options.cwd.length === 0) {
        throw new TypeError("Process cwd must be a nonempty string")
    }
    if (options.cwd.includes("\0")) {
        throw new TypeError("Process cwd cannot contain a NUL byte")
    }
    if (!(options.signal instanceof AbortSignal)) {
        throw new TypeError("Process signal must be an AbortSignal")
    }
    if (options.timeoutMs !== undefined) {
        validateTimeout(options.timeoutMs)
    }

    if (!isRecord(options.outputLimits)) {
        throw new TypeError("Process outputLimits must be an object")
    }
    validateInteger(
        "outputLimits.stdoutBytes",
        options.outputLimits.stdoutBytes,
        0,
        MAX_CAPTURE_BYTES,
    )
    validateInteger(
        "outputLimits.stderrBytes",
        options.outputLimits.stderrBytes,
        0,
        MAX_CAPTURE_BYTES,
    )
    validateInteger(
        "outputLimits.progressTailBytes",
        options.outputLimits.progressTailBytes,
        0,
        MAX_PROGRESS_TAIL_BYTES,
    )
    if (options.onProgress !== undefined && typeof options.onProgress !== "function") {
        throw new TypeError("Process onProgress must be a function")
    }
    if (
        options.onOutputChunk !== undefined
        && typeof options.onOutputChunk !== "function"
    ) {
        throw new TypeError("Process onOutputChunk must be a function")
    }
}

async function validateWorkingDirectory(
    cwd: string,
    signal: AbortSignal,
): Promise<void> {
    let cwdStat
    try {
        cwdStat = await stat(cwd)
    } catch (error) {
        signal.throwIfAborted()
        const code = errno(error)
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new Error(`Process cwd does not exist: ${JSON.stringify(cwd)}`)
        }
        throw new Error(
            `Cannot access process cwd ${JSON.stringify(cwd)}: ${errorMessage(error)}`,
        )
    }
    signal.throwIfAborted()
    if (!cwdStat.isDirectory()) {
        throw new Error(`Process cwd is not a directory: ${JSON.stringify(cwd)}`)
    }
}

function validateInteger(
    name: string,
    value: number,
    minimum: number,
    maximum: number,
): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(
            `Process ${name} must be an integer from ${minimum} to ${maximum}`,
        )
    }
}

function validateTimeout(value: number): void {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
        throw new TypeError(
            `Process timeoutMs must be a finite number greater than 0 and at most ${MAX_TIMEOUT_MS}`,
        )
    }
}

function outputReadError(stream: "stdout" | "stderr", error: unknown): Error {
    return new Error(`Cannot read Bash process ${stream}: ${errorMessage(error)}`)
}

function processFailureAfterStart(
    error: Error,
    cleanupWarning: string | undefined,
): ProcessSideEffectsUnknownError {
    return new ProcessSideEffectsUnknownError(
        `${error.message}; the command started, so side effects may have occurred.`,
        error,
        cleanupWarning,
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function errno(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? String(error.code)
        : undefined
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
