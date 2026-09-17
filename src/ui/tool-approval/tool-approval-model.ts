/** State-free contracts and action policy for built-in tool approvals. */
import type { KeyEvent } from "@opentui/core"

import type {
    TToolApprovalDecision,
    TToolApprovalRequest,
} from "@/agent"

export type TToolApprovalKeyboardAction =
    | "approval.previous"
    | "approval.next"
    | "approval.activate"
    | "approval.scrollUp"
    | "approval.scrollDown"
    | "approval.scrollStart"
    | "approval.scrollEnd"

export interface IToolApprovalPanelProps {
    readonly request: TToolApprovalRequest
    readonly onResolve: (
        approvalId: string,
        decision: TToolApprovalDecision,
        beforeResolve?: () => boolean,
    ) => void
    readonly onError: (error: unknown) => void
    readonly resolveKeyboardAction: (
        key: KeyEvent,
    ) => TToolApprovalKeyboardAction | undefined
}

export interface IToolApprovalAction {
    readonly label: string
    readonly decision: TToolApprovalDecision
}

export const COMMAND_APPROVAL_ACTIONS: readonly IToolApprovalAction[] = [
    { label: "Copy", decision: "copy" },
    { label: "Run once", decision: "approve" },
    { label: "Reject", decision: "reject" },
]

export function getToolApprovalActions(
    _request: TToolApprovalRequest,
): readonly IToolApprovalAction[] {
    return COMMAND_APPROVAL_ACTIONS
}
