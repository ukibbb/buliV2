import { isAbsolute, resolve } from "node:path"

import type {
    IAgentHooks,
    IHookDecision,
    IToolCallContent,
    IToolResultMessage,
    IUserMessage,
} from "@/agent"
import type { THookConfiguration, THookEventName } from "@/integrations/claude-code/settings"
import { type IHookCommandResult, runHookCommand } from "@/integrations/claude-code/hook-command"

/** Claude Code tool names for Buli tools, so hook matchers such as `Bash|Write|Edit` apply. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
    read: "Read",
    write: "Write",
    edit: "MultiEdit",
    bash: "Bash",
    grep: "Grep",
    find: "Glob",
    delegate_task: "Task",
    web_search: "WebSearch",
}

/** Buli tools whose `path` input Claude Code hooks read as an absolute `file_path`. */
const FILE_PATH_TOOLS = new Set(["read", "write", "edit"])

interface IClaudeToolCall {
    readonly name: string
    readonly input: Record<string, unknown>
}

/** Event-specific fields of Claude Code's hook input. */
type TClaudeHookEventInput =
    | { readonly source: "startup" }
    | { readonly prompt: string }
    | {
        readonly tool_name: string
        readonly tool_input: Record<string, unknown>
        readonly tool_response?: { readonly content: string; readonly is_error: boolean }
    }

/** Runs one session's Claude Code command hooks with Claude Code's input and output protocol. */
export class ClaudeCodeHooks implements IAgentHooks {
    private sessionStarted = false

    constructor(private readonly options: {
        readonly sessionId: string
        readonly workspaceRoot: string
        readonly hooks: THookConfiguration
    }) {}

    /** The session's first prompt also runs SessionStart; its context cannot block. */
    async beforePrompt(message: IUserMessage, signal: AbortSignal): Promise<IHookDecision> {
        const start = this.sessionStarted
            ? {}
            : await this.run("SessionStart", "startup", { source: "startup" }, signal)
        this.sessionStarted = true
        const prompt = await this.run("UserPromptSubmit", undefined, { prompt: message.content }, signal)
        return mergeDecisions([{ ...(start.context ? { context: start.context } : {}) }, prompt])
    }

    async beforeTool(call: IToolCallContent, signal: AbortSignal): Promise<IHookDecision> {
        const tool = this.toClaudeToolCall(call)
        return await this.run("PreToolUse", tool.name, { tool_name: tool.name, tool_input: tool.input }, signal)
    }

    /** A PostToolUse block cannot undo the call; Claude Code feeds its reason to the model. */
    async afterTool(call: IToolCallContent, result: IToolResultMessage, signal: AbortSignal): Promise<string | undefined> {
        const tool = this.toClaudeToolCall(call)
        const decision = await this.run("PostToolUse", tool.name, {
            tool_name: tool.name,
            tool_input: tool.input,
            tool_response: { content: result.content, is_error: result.isError },
        }, signal)
        return joinText([decision.blockReason, decision.context])
    }

    private async run(
        event: THookEventName,
        target: string | undefined,
        eventInput: TClaudeHookEventInput,
        signal: AbortSignal,
    ): Promise<IHookDecision> {
        const commands = (this.options.hooks[event] ?? [])
            .filter((group) => target === undefined || matches(group.matcher, target))
            .flatMap((group) => group.hooks)
        if (commands.length === 0) return {}
        const input = {
            session_id: this.options.sessionId,
            cwd: this.options.workspaceRoot,
            hook_event_name: event,
            permission_mode: "default" as const,
            ...eventInput,
        }
        const results = await Promise.all(commands.map((command) =>
            runHookCommand(command, input, { cwd: this.options.workspaceRoot, signal })
        ))
        return mergeDecisions(results.map((result) => decisionFrom(event, result)))
    }

    /** Claude Code hooks read `file_path` as an absolute path and Edit fields as `old_string`/`new_string`. */
    private toClaudeToolCall(call: IToolCallContent): IClaudeToolCall {
        const name = CLAUDE_TOOL_NAMES[call.toolName] ?? call.toolName
        const { path, edits, ...rest } = call.input
        if (typeof path !== "string" || !FILE_PATH_TOOLS.has(call.toolName)) {
            return { name, input: call.input }
        }
        const file_path = isAbsolute(path) ? path : resolve(this.options.workspaceRoot, path)
        if (call.toolName !== "edit" || !Array.isArray(edits)) return { name, input: { ...rest, file_path } }
        return {
            name,
            input: {
                ...rest,
                file_path,
                edits: edits.map((edit: { oldText?: unknown; newText?: unknown }) => ({
                    old_string: edit.oldText,
                    new_string: edit.newText,
                })),
            },
        }
    }
}

/** Claude Code matchers are regular expressions over the tool name; empty or `*` matches all. */
function matches(matcher: string | undefined, target: string): boolean {
    if (!matcher || matcher === "*") return true
    try {
        return new RegExp(`^(?:${matcher})$`).test(target)
    } catch {
        return matcher === target
    }
}

/**
 * Exit 2 blocks with stderr; exit 0 may print JSON with a decision or `additionalContext`.
 * Plain stdout is context only for SessionStart and UserPromptSubmit. Other exits are non-blocking errors.
 */
function decisionFrom(event: THookEventName, result: IHookCommandResult): IHookDecision {
    if (result.exitCode === 2) return { blockReason: result.stderr.trim() || "blocked by hook" }
    if (result.exitCode !== 0) return {}
    const stdout = result.stdout.trim()
    const output = parseJsonObject(stdout)
    if (output === undefined) {
        return stdout && (event === "SessionStart" || event === "UserPromptSubmit") ? { context: stdout } : {}
    }
    const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : {}
    const blockReason = blockReasonFrom(output, specific)
    const context = typeof specific.additionalContext === "string" && specific.additionalContext.trim()
        ? specific.additionalContext.trim()
        : undefined
    return {
        ...(blockReason === undefined ? {} : { blockReason }),
        ...(context === undefined ? {} : { context }),
    }
}

/** Claude Code's precedence: `continue: false`, then `decision: "block"`, then a denied permission. */
function blockReasonFrom(output: Record<string, unknown>, specific: Record<string, unknown>): string | undefined {
    if (output.continue === false) return textOr(output.stopReason, "stopped by hook")
    if (output.decision === "block") return textOr(output.reason, "blocked by hook")
    if (specific.permissionDecision === "deny") return textOr(specific.permissionDecisionReason, "denied by hook")
    return undefined
}

function mergeDecisions(decisions: readonly IHookDecision[]): IHookDecision {
    const blockReason = joinText(decisions.map((decision) => decision.blockReason))
    const context = joinText(decisions.map((decision) => decision.context))
    return {
        ...(blockReason === undefined ? {} : { blockReason }),
        ...(context === undefined ? {} : { context }),
    }
}

function joinText(parts: readonly (string | undefined)[]): string | undefined {
    const text = parts.filter((part) => part !== undefined && part !== "").join("\n\n")
    return text || undefined
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
    if (!text.startsWith("{")) return undefined
    try {
        const value: unknown = JSON.parse(text)
        return isRecord(value) ? value : undefined
    } catch {
        return undefined
    }
}

function textOr(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
