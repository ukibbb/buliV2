import { Type } from "typebox"

import type {
    IAgentTool,
    IToolOutputStore,
    IToolOutputWriter,
} from "@/agent"
import {
    PROCESS_INTERPRETER_DISPLAY,
    runShellProcess,
    type IProcessRunnerResult,
} from "@/tools/command/process-runner"

const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1_000
// Two previews plus metadata must stay below the central 100 KB result budget.
const OUTPUT_BYTES = 40 * 1024
const INPUT_KEYS = new Set(["command", "timeout"])

// Public schema ported from Pi 6c87d9a026677b601e8278030dcf1ad97fe0bd86
// (c) 2025 Mario Zechner, MIT License.
const BASH_INPUT_SCHEMA = Type.Object({
    command: Type.String({
        description: "Shell command to execute",
    }),
    timeout: Type.Optional(Type.Number({
        description: "Timeout in seconds (optional, no default timeout)",
    })),
})

/** Creates the tool for running one Bash command in the workspace root. */
export function createBashTool(
    workspaceRoot: string,
    toolOutputStore?: IToolOutputStore,
): IAgentTool<typeof BASH_INPUT_SCHEMA> {
    return {
        name: "bash",
        description: `Execute one Bash command immediately in the workspace root using ${PROCESS_INTERPRETER_DISPLAY}. Returns separate stdout and stderr previews; timeout is optional and has no default. It is not a sandbox, and deliberately detached descendants may outlive the run. Obtain the conversational approval required by the system prompt before calling this tool. Prefer read, find, and grep for inspection, and edit or write for file changes.`,
        inputSchema: BASH_INPUT_SCHEMA,
        execute: async (input, context) => {
            assertOnlyInputKeys(input)
            const command = requireNonEmptyString(input, "command")
            if (command.includes("\0")) {
                throw new TypeError("Tool input command cannot contain a NUL byte")
            }
            const timeout = optionalTimeoutSeconds(input)

            const outputWriter = await createCommandOutputWriter(toolOutputStore, context)
            let result: IProcessRunnerResult
            try {
                result = await runShellProcess({
                    command,
                    cwd: workspaceRoot,
                    signal: context.signal,
                    ...(timeout === undefined ? {} : { timeoutMs: timeout * 1_000 }),
                    outputLimits: {
                        stdoutBytes: OUTPUT_BYTES,
                        stderrBytes: OUTPUT_BYTES,
                        progressTailBytes: 0,
                    },
                    ...(outputWriter === undefined
                        ? {}
                        : {
                            onOutputChunk: async (stream, chunk) => {
                                await outputWriter.write(stream, chunk)
                            },
                        }),
                })
            } catch (error) {
                throw await commandFailureWithObservedOutput(error, outputWriter)
            }

            let outputId: string | undefined
            if (
                result.stdoutTruncated
                || result.stderrTruncated
                || result.stdoutInvalidUtf8
                || result.stderrInvalidUtf8
            ) {
                if (!outputWriter) {
                    throw commandOutputUnavailableError(
                        "Bash completed, but its output exceeded inline limits and no complete output store is configured",
                    )
                }
                try {
                    outputId = (await outputWriter.commit()).outputId
                } catch (error) {
                    await outputWriter.discard().catch(() => {})
                    throw commandOutputUnavailableError(
                        `Bash completed, but its complete output could not be stored: ${errorMessage(error)}`,
                    )
                }
            } else {
                try {
                    await outputWriter?.discard()
                } catch (error) {
                    throw commandOutputUnavailableError(
                        `Bash completed, but its temporary output could not be discarded: ${errorMessage(error)}`,
                    )
                }
            }
            return {
                content: formatResult(workspaceRoot, timeout, result, outputId),
                outcome: commandOutcome(result),
                summary: commandSummary(result, timeout),
            }
        },
    }
}

function formatResult(
    cwd: string,
    timeoutSeconds: number | undefined,
    result: IProcessRunnerResult,
    outputId?: string,
): string {
    return [
        `cwd: ${JSON.stringify(cwd)}`,
        `exit code: ${result.exitCode}`,
        result.timedOut && timeoutSeconds !== undefined
            ? `timed out: yes (limit: ${timeoutSeconds} seconds)`
            : result.timedOut ? "timed out: yes" : "timed out: no",
        ...(result.cleanupWarning ? [`cleanup warning: ${result.cleanupWarning}`] : []),
        ...(result.timedOut || result.cleanupWarning
            ? ["warning: side effects and detached process state may be unknown; inspect before retrying"]
            : []),
        ...(outputId === undefined
            ? []
            : [
                `complete outputId: ${outputId}`,
                "use tool_output with part=\"stdout\" or part=\"stderr\" to read exact pages",
                ...(result.stdoutInvalidUtf8 || result.stderrInvalidUtf8
                    ? ["use encoding=\"base64\" for streams marked as invalid UTF-8"]
                    : []),
            ]),
        streamHeading(
            "stdout",
            result.stdoutTruncated,
            result.stdoutInvalidUtf8,
        ),
        result.stdout || "(empty)",
        streamHeading(
            "stderr",
            result.stderrTruncated,
            result.stderrInvalidUtf8,
        ),
        result.stderr || "(empty)",
    ].join("\n")
}

function streamHeading(
    stream: "stdout" | "stderr",
    truncated: boolean,
    invalidUtf8: boolean,
): string {
    if (invalidUtf8) return `${stream} lossy UTF-8 preview:`
    return truncated ? `${stream} preview:` : `${stream}:`
}

async function createCommandOutputWriter(
    store: IToolOutputStore | undefined,
    context: {
        readonly sessionId: string
        readonly runId: string
        readonly toolCallId: string
    },
): Promise<IToolOutputWriter | undefined> {
    if (!store) return undefined
    const writer = await store.createWriter({
        sessionId: context.sessionId,
        runId: context.runId,
        toolCallId: context.toolCallId,
        toolName: "bash",
    })
    try {
        await writer.write("stdout", new Uint8Array())
        await writer.write("stderr", new Uint8Array())
        return writer
    } catch (error) {
        await writer.discard().catch(() => {})
        throw error
    }
}

async function commandFailureWithObservedOutput(
    error: unknown,
    writer: IToolOutputWriter | undefined,
): Promise<unknown> {
    if (!writer) return error
    if (!hasUnknownSideEffects(error)) {
        await writer.discard().catch(() => {})
        return error
    }
    try {
        const { outputId } = await writer.commit()
        const wrapped = new Error(
            `${errorMessage(error)} Observed command output was stored as outputId=${JSON.stringify(outputId)}; it may be incomplete.`,
            { cause: error },
        ) as Error & { sideEffectsUnknown: true }
        wrapped.sideEffectsUnknown = true
        return wrapped
    } catch (storageError) {
        await writer.discard().catch(() => {})
        return commandOutputUnavailableError(
            `${errorMessage(error)} Complete observed output could not be stored: ${errorMessage(storageError)}`,
        )
    }
}

function commandOutputUnavailableError(message: string): Error {
    const error = new Error(
        `${message}. The command may have produced side effects; inspect the workspace before retrying.`,
    ) as Error & { sideEffectsUnknown: true }
    error.sideEffectsUnknown = true
    return error
}

function hasUnknownSideEffects(error: unknown): boolean {
    return error !== null
        && typeof error === "object"
        && "sideEffectsUnknown" in error
        && error.sideEffectsUnknown === true
}

function commandSummary(
    result: IProcessRunnerResult,
    timeoutSeconds: number | undefined,
): string {
    if (result.timedOut) {
        const duration = timeoutSeconds === undefined
            ? "the configured limit"
            : `${timeoutSeconds} seconds`
        return `Command timed out after ${duration}; inspect side effects before `
            + `retrying with a larger timeout of at most ${MAX_TIMEOUT_SECONDS} seconds`
    }
    if (result.cleanupWarning) {
        return `Command exited with code ${result.exitCode}; process cleanup was not confirmed`
    }
    return `Command exited with code ${result.exitCode}`
}

function commandOutcome(
    result: IProcessRunnerResult,
): "completed" | "failed" | "effects-unknown" {
    if (result.timedOut || result.cleanupWarning !== undefined) {
        return "effects-unknown"
    }
    return result.exitCode === 0 ? "completed" : "failed"
}

function assertOnlyInputKeys(input: Record<string, unknown>): void {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("Tool input must be an object")
    }
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) {
            throw new TypeError(`Tool input contains unknown property ${JSON.stringify(key)}`)
        }
    }
}

function requireNonEmptyString(
    input: Record<string, unknown>,
    key: string,
): string {
    const value = input[key]
    if (typeof value !== "string") {
        throw new TypeError(`Tool input ${key} must be a string`)
    }
    if (value.trim().length === 0) {
        throw new TypeError(`Tool input ${key} cannot be empty`)
    }
    return value
}

function optionalTimeoutSeconds(
    input: Record<string, unknown>,
): number | undefined {
    const value = input.timeout
    if (value === undefined) return undefined
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new TypeError("Tool input timeout must be a finite number greater than 0")
    }
    if (value > MAX_TIMEOUT_SECONDS) {
        throw new TypeError(
            `Tool input timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds`,
        )
    }
    return value
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
