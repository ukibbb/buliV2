import { stat } from "node:fs/promises"
import { Type } from "typebox"

import type { AgentTool } from "@/agent"
import {
    PROCESS_INTERPRETER_DISPLAY,
    runShellProcess,
    type IProcessRunnerResult,
} from "@/tools/command/process-runner"
import { createWorkspacePathResolver } from "@/tools/paths"

const DEFAULT_TIMEOUT_SECONDS = 600
const MAX_TIMEOUT_SECONDS = 3_600
const OUTPUT_BYTES = 50 * 1024
const INPUT_KEYS = new Set([
    "command",
    "purpose",
    "explanation",
    "expectedOutcome",
    "sideEffects",
    "cwd",
    "timeout",
])

const REQUIRED_TEXT_OPTIONS = {
    minLength: 1,
    pattern: "\\S",
} as const

const BASH_INPUT_SCHEMA = Type.Object({
    command: Type.String({
        ...REQUIRED_TEXT_OPTIONS,
        description: "Exact shell command to run once",
    }),
    purpose: Type.String({
        ...REQUIRED_TEXT_OPTIONS,
        description: "What this command is intended to accomplish",
    }),
    explanation: Type.String({
        ...REQUIRED_TEXT_OPTIONS,
        description: "Why running this command is appropriate now",
    }),
    expectedOutcome: Type.String({
        ...REQUIRED_TEXT_OPTIONS,
        description: "Expected observable result",
    }),
    sideEffects: Type.String({
        ...REQUIRED_TEXT_OPTIONS,
        description: "Expected filesystem, process, or other side effects",
    }),
    cwd: Type.Optional(Type.String({
        ...REQUIRED_TEXT_OPTIONS,
        default: ".",
        description: "Workspace directory in which to run the command",
    })),
    timeout: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_SECONDS,
        default: DEFAULT_TIMEOUT_SECONDS,
        description: `Maximum execution time in seconds; defaults to ${DEFAULT_TIMEOUT_SECONDS} and cannot exceed ${MAX_TIMEOUT_SECONDS}`,
    })),
}, { additionalProperties: false })

/** Creates the approval-gated tool for running one workspace Bash command. */
export function createBashTool(
    workspaceRoot: string,
): AgentTool<typeof BASH_INPUT_SCHEMA> {
    const resolveWorkspacePath = createWorkspacePathResolver(workspaceRoot)

    return {
        name: "bash",
        approvalKind: "command",
        description: `Offer one exact command for Copy, Run once, or Reject. Run once uses ${PROCESS_INTERPRETER_DISPLAY} in a fresh non-interactive process after explicit approval. It is not a sandbox; deliberately detached descendants may outlive the run. Prefer read, glob, and grep for inspection, and apply_patch for file changes.`,
        inputSchema: BASH_INPUT_SCHEMA,
        execute: async (input, context) => {
            assertOnlyInputKeys(input)
            const command = requireNonEmptyString(input, "command")
            if (command.includes("\0")) {
                throw new TypeError("Tool input command cannot contain a NUL byte")
            }
            const purpose = requireNonEmptyString(input, "purpose")
            const explanation = requireNonEmptyString(input, "explanation")
            const expectedOutcome = requireNonEmptyString(input, "expectedOutcome")
            const sideEffects = requireNonEmptyString(input, "sideEffects")
            const cwd = optionalNonEmptyString(input, "cwd") ?? "."
            const timeout = optionalInteger(
                input,
                "timeout",
                DEFAULT_TIMEOUT_SECONDS,
                1,
                MAX_TIMEOUT_SECONDS,
            )

            const resolvedCwd = await resolveWorkspacePath(cwd, context.signal)
            const approvedCwdIdentity = await requireDirectory(
                resolvedCwd.target,
                cwd,
                context.signal,
            )
            const requestApproval = context.requestApproval
            if (!requestApproval) {
                throw new Error(
                    "bash cannot run the command because tool approval is unavailable; "
                    + "no process was started.",
                )
            }

            const decision = await requestApproval({
                kind: "command",
                title: `Command proposal (${PROCESS_INTERPRETER_DISPLAY})`,
                explanation,
                command,
                cwd: resolvedCwd.target,
                purpose,
                expectedOutcome,
                sideEffects,
                timeoutSeconds: timeout,
            })
            if (decision === "reject") {
                return {
                    content: "Command approval was rejected; no process was started.",
                    outcome: "rejected",
                    summary: "Command rejected; no process started",
                }
            }
            if (decision === "copy") {
                return {
                    content: "The command was copied for manual execution; no process was started.",
                    outcome: "manual",
                    summary: "Command copied; run it manually and share the result",
                }
            }
            if (decision !== "approve") {
                throw new Error(
                    `bash requires an approve, reject, or copy decision, received `
                    + `${JSON.stringify(decision)}; no process was started.`,
                )
            }

            const currentCwd = await resolveWorkspacePath(resolvedCwd.target, context.signal)
            if (currentCwd.target !== resolvedCwd.target) {
                throw new Error(
                    "The approved working directory changed before execution; "
                    + "no process was started.",
                )
            }
            const currentCwdIdentity = await requireDirectory(
                currentCwd.target,
                cwd,
                context.signal,
            )
            if (
                currentCwdIdentity.device !== approvedCwdIdentity.device
                || currentCwdIdentity.inode !== approvedCwdIdentity.inode
            ) {
                throw new Error(
                    "The approved working directory identity changed before execution; "
                    + "no process was started.",
                )
            }

            const result = await runShellProcess({
                command,
                cwd: currentCwd.target,
                signal: context.signal,
                timeoutMs: timeout * 1_000,
                outputLimits: {
                    stdoutBytes: OUTPUT_BYTES,
                    stderrBytes: OUTPUT_BYTES,
                    progressTailBytes: 0,
                },
            })
            return {
                content: formatResult(currentCwd.target, timeout, result),
                outcome: commandOutcome(result),
                summary: commandSummary(result, timeout),
            }
        },
    }
}

function formatResult(
    cwd: string,
    timeoutSeconds: number,
    result: IProcessRunnerResult,
): string {
    return [
        `cwd: ${JSON.stringify(cwd)}`,
        `exit code: ${result.exitCode}`,
        result.timedOut
            ? `timed out: yes (limit: ${timeoutSeconds} seconds)`
            : "timed out: no",
        ...(result.cleanupWarning ? [`cleanup warning: ${result.cleanupWarning}`] : []),
        ...(result.timedOut || result.cleanupWarning
            ? ["warning: side effects and detached process state may be unknown; inspect before retrying"]
            : []),
        "stdout:",
        result.stdout || "(empty)",
        "stderr:",
        result.stderr || "(empty)",
    ].join("\n")
}

function commandSummary(
    result: IProcessRunnerResult,
    timeoutSeconds: number,
): string {
    if (result.timedOut) {
        return `Command timed out after ${timeoutSeconds} seconds; inspect side effects before `
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

async function requireDirectory(
    target: string,
    displayPath: string,
    signal: AbortSignal,
): Promise<{ readonly device: number; readonly inode: number }> {
    let pathStat
    try {
        pathStat = await stat(target)
    } catch (error) {
        signal.throwIfAborted()
        throw new Error(
            `Cannot inspect bash cwd ${JSON.stringify(displayPath)}: ${errorMessage(error)}`,
        )
    }
    signal.throwIfAborted()
    if (!pathStat.isDirectory()) {
        throw new Error(`Bash cwd is not a directory: ${JSON.stringify(displayPath)}`)
    }
    return { device: pathStat.dev, inode: pathStat.ino }
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

function optionalNonEmptyString(
    input: Record<string, unknown>,
    key: string,
): string | undefined {
    if (input[key] === undefined) return undefined
    return requireNonEmptyString(input, key)
}

function optionalInteger(
    input: Record<string, unknown>,
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const value = input[key]
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        throw new TypeError(`Tool input ${key} must be an integer of at least ${minimum}`)
    }
    if (Number(value) > maximum) {
        throw new TypeError(`Tool input ${key} must be at most ${maximum}`)
    }
    return Number(value)
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
