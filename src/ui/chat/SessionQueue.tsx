import type { ISessionSnapshot } from "@/sessions"
import { QueuedMessages } from "@/ui/chat/QueuedMessages"
import { useSessionSelector } from "@/ui/context/application-context"
import { useBuliUiSelector } from "@/ui/context/ui-controller-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"

/** Queue updates never rerender the editor, status or transcript. */
export function SessionQueue(props: { readonly sessionId: string | undefined }) {
    const queue = useSessionSelector(props.sessionId, selectQueue, sameSnapshotFields)
    const menuOpen = useBuliUiSelector((snapshot) => snapshot.menu !== null)
    return <QueuedMessages steering={queue.steering} followUps={queue.followUps} showHint={!queue.active} menuOpen={menuOpen} />
}

function selectQueue(session: ISessionSnapshot) {
    return {
        steering: session.pendingSteeringMessages,
        followUps: session.pendingFollowUpMessages,
        active: session.isRunning || session.isCompacting,
    }
}
