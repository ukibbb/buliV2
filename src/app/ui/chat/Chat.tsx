import { useEffect } from "react"

import { ChatStatus } from "@/app/ui/chat/ChatStatus"
import { CommandMenu } from "@/app/ui/chat/CommandMenu"
import { PromptEditor } from "@/app/ui/chat/PromptEditor"
import { useBuliApplicationSnapshot } from "@/app/ui/context/application-context"
import {
    useBuliUiController,
    useBuliUiSnapshot,
} from "@/app/ui/context/ui-controller-context"
import type {
    IUserMessage,
    TAgentRunEndReason,
    TToolApprovalRequest,
} from "@/agent"
import type { IContextUsage } from "@/sessions"

interface IChatProps {
    readonly isRunning?: boolean
    readonly isCompacting?: boolean
    readonly contextUsage?: IContextUsage | undefined
    readonly pendingSteeringMessages?: readonly IUserMessage[]
    readonly pendingFollowUpMessages?: readonly IUserMessage[]
    readonly pendingToolApproval?: TToolApprovalRequest
    readonly lastRunReason?: TAgentRunEndReason
    readonly errorMessage?: string
}

/** Connects prompt, status, and command-menu views to application UI state. */
export function Chat(props: IChatProps) {
    const controller = useBuliUiController()
    const ui = useBuliUiSnapshot()
    const application = useBuliApplicationSnapshot()
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
                value={ui.input}
                blocked={props.pendingToolApproval !== undefined}
                menuOpen={menu !== null}
                getCurrentValue={() => controller.getSnapshot().input}
                onValueChange={controller.updateInput}
                onSubmit={controller.submitInput}
                onMoveMenuSelection={controller.moveMenuSelection}
                onActivateMenuItem={controller.activateSelectedMenuItem}
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
