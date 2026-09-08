import type {
    TAgentRunEndReason,
    TToolApprovalRequest,
    IUserMessage,
} from "@/agent"
import { SnakeAnimation } from "@/app/ui/chat/Snake"
import type { IContextUsage } from "@/sessions"
import { theme } from "@/terminal/theme"

interface IChatStatusProps {
    readonly isRunning: boolean | undefined
    readonly isCompacting: boolean | undefined
    readonly contextUsage: IContextUsage | undefined
    readonly pendingSteeringMessages: readonly IUserMessage[] | undefined
    readonly pendingFollowUpMessages: readonly IUserMessage[] | undefined
    readonly pendingToolApproval: TToolApprovalRequest | undefined
    readonly lastRunReason: TAgentRunEndReason | undefined
    readonly errorMessage: string | undefined
    readonly inputError: string | null
    readonly selectedModelName: string
    readonly reasoningEffort: string
}

/** Renders run, approval, queue, error, model, and reasoning status. */
export function ChatStatus(props: IChatStatusProps) {
    const pendingSteeringCount = props.pendingSteeringMessages?.length ?? 0
    const pendingFollowUpCount = props.pendingFollowUpMessages?.length ?? 0
    const pendingMessageCount = pendingSteeringCount + pendingFollowUpCount

    return (
        <box
            width="100%"
            flexShrink={0}
            flexDirection="row"
            flexWrap="wrap"
            paddingLeft={1}
            paddingBottom={1}
            gap={1}
        >
            {props.pendingToolApproval ? (
                <text fg={theme.amber}>Waiting for your decision</text>
            ) : props.isCompacting ? (
                <box flexDirection="row">
                    <SnakeAnimation />
                    <text fg={theme.amber}>Compacting context · Esc stop</text>
                </box>
            ) : props.isRunning ? (
                <box flexDirection="row">
                    <SnakeAnimation />
                    <text fg={theme.textMuted}>
                        Enter steer | Alt+Enter follow-up | Esc stop
                    </text>
                </box>
            ) : null}
            {props.pendingToolApproval && pendingMessageCount > 0 ? (
                <text fg={theme.textMuted}>
                    {`Queued: ${pendingSteeringCount} steering, ${pendingFollowUpCount} follow-up`}
                </text>
            ) : null}
            {!props.pendingToolApproval && props.pendingSteeringMessages?.map((message) => (
                <text key={message.id} fg={theme.textMuted}>
                    {`Steering: ${message.content}`}
                </text>
            ))}
            {!props.pendingToolApproval && props.pendingFollowUpMessages?.map((message) => (
                <text key={message.id} fg={theme.textMuted}>
                    {`Follow-up: ${message.content}`}
                </text>
            ))}
            {!props.pendingToolApproval && pendingMessageCount > 0 ? (
                <text fg={theme.textMuted}>Esc restores queued input</text>
            ) : null}
            {!props.isRunning && !props.isCompacting && props.lastRunReason === "aborted" ? (
                <text fg={theme.textMuted}>Operation aborted</text>
            ) : null}
            {!props.isCompacting && props.errorMessage ? (
                <text
                    fg={theme.red}
                    minWidth={0}
                    flexShrink={1}
                    wrapMode="word"
                >{props.errorMessage}</text>
            ) : null}
            {props.inputError ? (
                <text
                    fg={theme.red}
                    minWidth={0}
                    flexShrink={1}
                    wrapMode="word"
                >{props.inputError}</text>
            ) : null}
            {/* Keep safety numbers readable beside run hints and long model names;
                truncation can retain a label but hide the budget that drives it. */}
            <text minWidth={0} flexShrink={1} truncate={false} wrapMode="word">
                <span fg={theme.green}>{props.selectedModelName}</span>
                <span> / </span>
                <span fg={theme.amber}>{props.reasoningEffort}</span>
                {props.contextUsage ? <>
                    <span fg={theme.textMuted}>
                        {` · ${formatContextUsage(props.contextUsage)}`}
                    </span>
                    <span fg={compactionBudgetColor(props.contextUsage)}>
                        {` · ${formatCompactionBudget(props.contextUsage)}`}
                    </span>
                </> : null}
            </text>
        </box>
    )
}

function formatContextUsage(usage: IContextUsage): string {
    const used = formatTokens(usage.estimatedInputTokens)
    if (usage.contextWindowTokens === undefined) return `ctx ~${used}`
    const percent = Math.round((usage.usageRatio ?? 0) * 100)
    return `ctx ~${used}/${formatTokens(usage.contextWindowTokens)} (${percent}%)`
}

function formatCompactionBudget(usage: IContextUsage): string {
    const threshold = usage.compactionThresholdTokens
    if (threshold === undefined) return "compact limit unknown"
    const percent = Math.round(usage.compactionInputTokens / threshold * 100)
    return `compact ${formatTokens(usage.compactionInputTokens)}/${formatTokens(threshold)} (${percent}% budget)`
}

function compactionBudgetColor(usage: IContextUsage): string {
    if (usage.shouldCompact) return theme.red
    // Keep the former 70%-window warning's distance from the 80% threshold,
    // but use the same safety numerator shown in this field and used by preflight.
    // Otherwise an unanchored request could skip amber and turn red at 40% ctx.
    const threshold = usage.compactionThresholdTokens
    if (threshold !== undefined && usage.compactionInputTokens / threshold >= 0.7 / 0.8) {
        return theme.amber
    }
    return theme.textMuted
}

function formatTokens(value: number): string {
    if (value < 1_000) return Math.max(0, value).toLocaleString()
    if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
    if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}m`
    return `${Math.round(value / 1_000_000)}m`
}
