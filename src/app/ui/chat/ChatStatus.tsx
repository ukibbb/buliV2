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
    readonly menuOpen: boolean
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
            justifyContent="space-between"
            columnGap={2}
            paddingLeft={1}
            paddingRight={1}
            paddingBottom={1}
            paddingTop={1}
            backgroundColor={theme.surface}
        >
            {!props.menuOpen ? (
                <box minWidth={0} flexGrow={1} flexDirection="column" rowGap={1}>
                    {props.pendingToolApproval ? (
                        <text
                            fg={theme.amber}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                        >Waiting for your decision</text>
                    ) : props.isRunning ? (
                        <box flexDirection="row" columnGap={1}>
                            <SnakeAnimation />
                            <text
                                fg={theme.textMuted}
                                selectionBg={theme.selectionBg}
                                selectionFg={theme.selectionFg}
                                wrapMode="word"
                            >
                                Enter steer | Alt+Enter follow-up | Esc stop
                            </text>
                        </box>
                    ) : null}
                    {props.pendingToolApproval && pendingMessageCount > 0 ? (
                        <text
                            fg={theme.textMuted}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                            wrapMode="word"
                        >
                            {`Queued: ${pendingSteeringCount} steering, ${pendingFollowUpCount} follow-up`}
                        </text>
                    ) : null}
                    {!props.pendingToolApproval && props.pendingSteeringMessages?.map((message) => (
                        <text
                            key={message.id}
                            fg={theme.textMuted}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                            wrapMode="word"
                        >
                            {`Steering: ${message.content}`}
                        </text>
                    ))}
                    {!props.pendingToolApproval && props.pendingFollowUpMessages?.map((message) => (
                        <text
                            key={message.id}
                            fg={theme.textMuted}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                            wrapMode="word"
                        >
                            {`Follow-up: ${message.content}`}
                        </text>
                    ))}
                    {!props.pendingToolApproval && pendingMessageCount > 0 ? (
                        <text
                            fg={theme.textMuted}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                        >Esc restores queued input</text>
                    ) : null}
                    {!props.isRunning && props.lastRunReason === "aborted" ? (
                        <text
                            fg={theme.textMuted}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                        >Operation aborted</text>
                    ) : null}
                    {props.errorMessage ? (
                        <text
                            fg={theme.red}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                            wrapMode="word"
                        >{props.errorMessage}</text>
                    ) : null}
                    {props.inputError ? (
                        <text
                            fg={theme.red}
                            selectionBg={theme.selectionBg}
                            selectionFg={theme.selectionFg}
                            wrapMode="word"
                        >{props.inputError}</text>
                    ) : null}
                </box>
            ) : null}
            <text
                minWidth={0}
                maxWidth="40%"
                flexShrink={1}
                marginLeft="auto"
                truncate
                wrapMode="none"
                selectionBg={theme.selectionBg}
                selectionFg={theme.selectionFg}
            >
                <span fg={theme.green}>{props.selectedModelName}</span>
                <span fg={theme.textSubtle}> / </span>
                <span fg={theme.amber}>{props.reasoningEffort}</span>
            </text>
        </box>
    )
}
