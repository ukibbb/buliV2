import type {
    IUserMessage,
    TAgentRunEndReason,
    TToolApprovalRequest,
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
            paddingLeft={1}
            paddingBottom={1}
            gap={1}
        >
            {props.pendingToolApproval ? (
                <text fg={theme.amber}>Waiting for your decision</text>
            ) : props.isCompacting ? (
                <text fg={theme.amber}>Compacting context | Esc stop</text>
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
            {props.errorMessage ? (
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
            <text minWidth={0} flexShrink={1} truncate wrapMode="none">
                <span fg={theme.green}>{props.selectedModelName}</span>
                <span> / </span>
                <span fg={theme.amber}>{props.reasoningEffort}</span>
                {props.contextUsage ? <span fg={contextUsageColor(props.contextUsage)}>
                    {` · ${formatContextUsage(props.contextUsage)}`}
                </span> : null}
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

function contextUsageColor(usage: IContextUsage): string {
    if (usage.shouldCompact) return theme.red
    if ((usage.usageRatio ?? 0) >= 0.7) return theme.amber
    return theme.textMuted
}

function formatTokens(value: number): string {
    if (value < 1_000) return Math.max(0, value).toLocaleString()
    if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
    if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}m`
    return `${Math.round(value / 1_000_000)}m`
}
