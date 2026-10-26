import type {
    IAgentHooks,
    IHookDecision,
    IToolCallContent,
    IToolResultMessage,
    IUserMessage,
    TAgentMessage,
} from "@/agent"
import type { THookConfiguration, THookEventName } from "@/integrations/claude-code/settings"
import { type IHookCommandResult, runHookCommand } from "@/integrations/claude-code/hook-command"
import { toClaudeToolCall } from "@/integrations/claude-code/tool-calls"
import { ClaudeTranscript } from "@/integrations/claude-code/transcript"

/** Event-specific fields of Claude Code's hook input. */
type TClaudeHookEventInput =
    | { readonly source: "startup" }
    | { readonly stop_hook_active: false }
    | { readonly reason: "other" }
    | { readonly prompt: string }
    | {
        readonly tool_name: string
        readonly tool_input: Record<string, unknown>
        readonly tool_response?: { readonly content: string; readonly is_error: boolean }
    }

/**
 * Runs one session's Claude Code command hooks with Claude Code's input and output protocol and keeps
 * the session's Claude Code transcript, which the hooks read. Stop hooks only run for their effects:
 * Buli does not continue a response a Stop hook blocks.
 */
export class ClaudeCodeHooks implements IAgentHooks {
    private sessionStarted = false
    private readonly transcript: ClaudeTranscript
    /** Stop hooks still running; the session's end waits for them. */
    private readonly backgroundRuns = new Set<Promise<IHookDecision>>()

    constructor(private readonly options: {
        readonly sessionId: string
        readonly workspaceRoot: string
        readonly hooks: THookConfiguration
    }) {
        this.transcript = new ClaudeTranscript(options.sessionId, options.workspaceRoot)
    }

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
        const tool = toClaudeToolCall(call, this.options.workspaceRoot)
        return await this.run("PreToolUse", tool.name, { tool_name: tool.name, tool_input: tool.input }, signal)
    }

    /** A PostToolUse block cannot undo the call; Claude Code feeds its reason to the model. */
    async afterTool(call: IToolCallContent, result: IToolResultMessage, signal: AbortSignal): Promise<string | undefined> {
        const tool = toClaudeToolCall(call, this.options.workspaceRoot)
        const decision = await this.run("PostToolUse", tool.name, {
            tool_name: tool.name,
            tool_input: tool.input,
            tool_response: { content: result.content, is_error: result.isError },
        }, signal)
        return joinText([decision.blockReason, decision.context])
    }

    afterMessage(message: TAgentMessage): void {
        this.transcript.append(message)
    }

    afterRun(): void {
        const run = this.run("Stop", undefined, { stop_hook_active: false }, new AbortController().signal)
        this.backgroundRuns.add(run)
        void run.finally(() => this.backgroundRuns.delete(run))
    }

    /** Pairs with SessionStart: a session only opened to read its history has no end to report. */
    async endSession(): Promise<void> {
        await Promise.allSettled(this.backgroundRuns)
        if (!this.sessionStarted) return
        await this.run("SessionEnd", undefined, { reason: "other" }, new AbortController().signal)
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
            transcript_path: this.transcript.path,
            hook_event_name: event,
            permission_mode: "default" as const,
            ...eventInput,
        }
        const results = await Promise.all(commands.map((command) =>
            runHookCommand(command, input, { cwd: this.options.workspaceRoot, signal })
        ))
        return mergeDecisions(results.map((result) => decisionFrom(event, result)))
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
