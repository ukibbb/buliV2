import { useTerminalDimensions } from "@opentui/react"

import type { IUserMessage } from "@/agent"
import { Keycap } from "@/ui/components/Keycap"
import { MessageCard } from "@/ui/components/MessageCard"
import { ClippedBox } from "@/ui/terminal/renderer/ClippedBox"
import { theme } from "@/ui/terminal/theme"

interface IQueuedMessagesProps {
    readonly steering: readonly IUserMessage[] | undefined
    readonly followUps: readonly IUserMessage[] | undefined
    readonly showHint?: boolean
    readonly menuOpen?: boolean
}

// Bounds for the height limit, not a guaranteed allocation: the queue can shrink to zero.
const MIN_QUEUE_HEIGHT_LIMIT_ROWS = 3
const MAX_QUEUE_HEIGHT_LIMIT_ROWS = 10
const QUEUE_HEIGHT_LIMIT_DIVISOR = 3
// Under pressure, the queue yields more space than the actively navigated menu.
const QUEUE_SHRINK_WEIGHT = 2

/** Queue content determines its desired height; layout limits the scroll viewport. */
export function QueuedMessages(props: IQueuedMessagesProps) {
    const { height } = useTerminalDimensions()
    const maxScrollRows = Math.max(
        MIN_QUEUE_HEIGHT_LIMIT_ROWS,
        Math.min(MAX_QUEUE_HEIGHT_LIMIT_ROWS, Math.floor(height / QUEUE_HEIGHT_LIMIT_DIVISOR)),
    )
    if (!props.steering?.length && !props.followUps?.length) return null

    return <ClippedBox
        id="queued-messages"
        width="100%"
        minHeight={0}
        flexShrink={QUEUE_SHRINK_WEIGHT}
        flexDirection="column"
    >
        <ClippedBox width="100%" minHeight={0} maxHeight={maxScrollRows} flexShrink={1} flexDirection="column">
            <scrollbox
                id="queued-messages-scroll"
                width="100%"
                minHeight={0}
                flexShrink={1}
                scrollY
                scrollX={false}
                wrapperOptions={{ minHeight: 0 }}
                viewportOptions={{ minHeight: 0 }}
                contentOptions={{ minHeight: 0, flexDirection: "column" }}
                verticalScrollbarOptions={{
                    width: 1,
                    showArrows: false,
                    trackOptions: {
                        backgroundColor: theme.surface,
                        foregroundColor: theme.textSecondary,
                    },
                }}
            >
                {props.steering?.map((message) => (
                    <MessageCard
                        key={message.id}
                        id={`queued-message-${message.id}`}
                        content={message.content}
                        title="Steering | queued"
                        borderColor={theme.amber}
                    />
                ))}
                {props.followUps?.map((message) => (
                    <MessageCard
                        key={message.id}
                        id={`queued-message-${message.id}`}
                        content={message.content}
                        title="Follow-up | queued"
                        borderColor={theme.green}
                    />
                ))}
            </scrollbox>
        </ClippedBox>
        {/* A box aligns the hint's allocation with the scroll viewport's cell grid. */}
        {props.showHint !== false ? <box flexShrink={0}>
            <text
                id="queued-messages-hint"
                fg={theme.textSecondary}
                wrapMode="word"
                paddingLeft={1}
            >
                <Keycap keys="Esc" />{props.menuOpen ? " close menu" : " restores queued input"}
            </text>
        </box> : null}
    </ClippedBox>
}
