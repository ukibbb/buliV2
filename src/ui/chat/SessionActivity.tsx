import type { ISessionSnapshot } from "@/sessions"
import { SnakeAnimation } from "@/ui/chat/Snake"
import { useSessionSelector } from "@/ui/context/application-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"
import { theme } from "@/ui/terminal/theme"

/** Run transitions update the activity; animation ticks stay inside SnakeAnimation. */
export function SessionActivity(props: { readonly sessionId: string | undefined }) {
    const activity = useSessionSelector(props.sessionId, selectActivity, sameSnapshotFields)
    return <box
        id="chat-activity"
        width="100%"
        minHeight={1}
        flexShrink={0}
        flexDirection="row"
        paddingLeft={1}
        gap={1}
    >
        {activity.isRunning || activity.isCompacting ? <>
            <box flexShrink={0}><SnakeAnimation /></box>
            <text minWidth={0} flexShrink={1} wrapMode="word" fg={activity.isCompacting ? theme.amber : theme.textMuted}>
                {activity.isCompacting
                    ? "Compacting context | Esc stop"
                    : "Enter steer | Alt+Enter follow-up | Esc stop"}
            </text>
        </> : null}
    </box>
}

function selectActivity(session: ISessionSnapshot) {
    return { isRunning: session.isRunning, isCompacting: session.isCompacting }
}
