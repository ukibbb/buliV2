import { useTerminalDimensions } from "@opentui/react"

import type { ISessionSnapshot } from "@/sessions"
import { SnakeAnimation } from "@/ui/chat/Snake"
import { Keycap } from "@/ui/components/Keycap"
import { useSessionSelector } from "@/ui/context/application-context"
import { useBuliUiSelector } from "@/ui/context/ui-controller-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"
import { theme } from "@/ui/terminal/theme"

const COMPACT_ACTIVITY_MAX_ROWS = 12

/** Run transitions update the activity; animation ticks stay inside SnakeAnimation. */
export function SessionActivity(props: { readonly sessionId: string | undefined }) {
    const activity = useSessionSelector(props.sessionId, selectActivity, sameSnapshotFields)
    const menuOpen = useBuliUiSelector((snapshot) => snapshot.menu !== null)
    const { height } = useTerminalDimensions()
    const compact = height <= COMPACT_ACTIVITY_MAX_ROWS
    if (!activity.isRunning && !activity.isCompacting) return null
    return <box width="100%" flexShrink={0} flexDirection="row" paddingX={1} gap={1}>
        <box id="chat-activity-snake" flexShrink={0}><SnakeAnimation /></box>
        <box id="chat-activity" flexGrow={1} minWidth={0}>
            <text minWidth={0} flexShrink={0} wrapMode={compact ? "none" : "word"} truncate={compact} fg={theme.text}>
                {!compact && activity.isCompacting ? <span fg={theme.violet}>Compacting context{"   "}</span> : null}
                {compact || activity.isCompacting ? null : <>
                    <Keycap keys="Enter" />{" steer   "}
                    <Keycap keys="Alt + Enter" />{" follow-up   "}
                </>}
                <Keycap keys="Esc" />
                {menuOpen ? " close menu" : activity.hasQueue
                    ? compact ? " stop + restore input" : " stop and restore queued input"
                    : " stop"}
            </text>
        </box>
    </box>
}

function selectActivity(session: ISessionSnapshot) {
    return {
        isRunning: session.isRunning,
        isCompacting: session.isCompacting,
        hasQueue: session.pendingSteeringMessages.length > 0 || session.pendingFollowUpMessages.length > 0,
    }
}
