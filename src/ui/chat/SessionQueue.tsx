import type { ISessionSnapshot } from "@/sessions"
import { QueuedMessages } from "@/ui/chat/QueuedMessages"
import { useSessionSelector } from "@/ui/context/application-context"
import { sameSnapshotFields } from "@/ui/context/use-snapshot-selector"

/** Queue updates never rerender the editor, status or transcript. */
export function SessionQueue(props: { readonly sessionId: string | undefined }) {
    const queue = useSessionSelector(props.sessionId, selectQueue, sameSnapshotFields)
    return <QueuedMessages steering={queue.steering} followUps={queue.followUps} />
}

function selectQueue(session: ISessionSnapshot) {
    return { steering: session.pendingSteeringMessages, followUps: session.pendingFollowUpMessages }
}
