import { memo, useEffect } from "react"

import { ChatStatus } from "@/app/ui/chat/ChatStatus"
import { CommandMenu } from "@/app/ui/chat/CommandMenu"
import { PromptEditor } from "@/app/ui/chat/PromptEditor"
import { useBuliApplicationSnapshot } from "@/app/ui/context/application-context"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/app/ui/context/ui-controller-context"
import type {
    AgentRunEndReason,
    ToolApprovalRequest,
    UserMessage,
} from "@/agent"
import type { IContextUsage } from "@/sessions"
import { useTerminalClipboard } from "@/terminal/clipboard/ClipboardOverlay"

interface IChatProps {
    readonly isRunning?: boolean
    readonly isCompacting?: boolean
    readonly contextUsage?: IContextUsage | undefined
    readonly pendingSteeringMessages?: readonly UserMessage[]
    readonly pendingFollowUpMessages?: readonly UserMessage[]
    readonly pendingToolApproval?: ToolApprovalRequest
    readonly lastRunReason?: AgentRunEndReason
    readonly errorMessage?: string
}

/** Connects prompt, status, and command-menu views to application UI state. */
function ChatView(props: IChatProps) {
    const controller = useBuliUiController()
    const ui = useBuliUiSnapshot()
    const application = useBuliApplicationSnapshot()
    const clipboard = useTerminalClipboard()
    const selectedModel = application.models.find(
        (model) => model.id === application.selection.modelId,
    )
    const selectedModelName = selectedModel?.name
        ?? application.selection.modelId

    useEffect(() => {
        if (props.pendingToolApproval) controller.dismissMenu()
    }, [controller, props.pendingToolApproval])

    const menu = props.pendingToolApproval ? null : ui.menu

    return (
        <box width="100%" flexShrink={0} flexDirection="column">
            <text>{controller.workspaceRoot}</text>
            <PromptEditor
                value={controller.getInputDraft()}
                blocked={props.pendingToolApproval !== undefined}
                menuOpen={menu !== null}
                {...(clipboard?.read
                    ? { clipboard: { read: clipboard.read } }
                    : {})}
                getCurrentValue={controller.getInputDraft}
                onValueChange={controller.updateDraft}
                onSubmit={controller.submitInput}
                onMoveMenuSelection={controller.moveMenuSelection}
                onActivateMenuItem={controller.activateSelectedMenuItem}
                onError={controller.setExternalUiError}
            />
            <ChatStatus
                isRunning={props.isRunning}
                isCompacting={props.isCompacting}
                contextUsage={props.contextUsage}
                pendingSteeringMessages={props.pendingSteeringMessages}
                pendingFollowUpMessages={props.pendingFollowUpMessages}
                pendingToolApproval={props.pendingToolApproval}
                lastRunReason={props.lastRunReason}
                errorMessage={props.errorMessage}
                inputError={ui.inputError}
                selectedModelName={selectedModelName}
                reasoningEffort={application.selection.reasoningEffort}
            />
            <CommandMenu menu={menu} />
        </box>
    )
}

// Queue arrays are defensively cloned; stable message IDs still let text-only
// streaming updates skip the unrelated prompt and status subtree.
export const Chat = memo(ChatView, (previous, next) => (
    previous.isRunning === next.isRunning
    && previous.isCompacting === next.isCompacting
    && previous.contextUsage === next.contextUsage
    && previous.pendingToolApproval === next.pendingToolApproval
    && previous.lastRunReason === next.lastRunReason
    && previous.errorMessage === next.errorMessage
    && sameMessageQueue(
        previous.pendingSteeringMessages,
        next.pendingSteeringMessages,
    )
    && sameMessageQueue(
        previous.pendingFollowUpMessages,
        next.pendingFollowUpMessages,
    )
))

function sameMessageQueue(
    previous: readonly UserMessage[] | undefined,
    next: readonly UserMessage[] | undefined,
): boolean {
    if (previous === next) return true
    if (previous === undefined || next === undefined) return false
    return previous.length === next.length
        && previous.every((message, index) => message.id === next[index]?.id)
}
