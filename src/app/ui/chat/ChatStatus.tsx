import type {
    IUserMessage,
    TAgentRunEndReason,
    TToolApprovalRequest,
} from "@/agent"
import { SnakeAnimation } from "@/app/ui/chat/Snake"
import { theme } from "@/terminal/theme"

interface IChatStatusProps {
    readonly isRunning: boolean | undefined
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
        >
            {props.pendingToolApproval ? (
                <text fg={theme.amber}>Waiting for your decision</text>
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
            {!props.isRunning && props.lastRunReason === "aborted" ? (
                <text fg={theme.textMuted}>Operation aborted</text>
            ) : null}
            {props.errorMessage ? (
                <text fg={theme.red}>{props.errorMessage}</text>
            ) : null}
            {props.inputError ? (
                <text fg={theme.red}>{props.inputError}</text>
            ) : null}
            <text>
                <span fg={theme.green}>{props.selectedModelName}</span>
                <span> / </span>
                <span fg={theme.amber}>{props.reasoningEffort}</span>
            </text>
        </box>
    )
}
