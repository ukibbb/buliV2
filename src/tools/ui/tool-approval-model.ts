/** State-free contracts and action policy for built-in tool approvals. */
import type { KeyEvent } from "@opentui/core"

import type {
    ToolApprovalDecision,
    ToolApprovalRequest,
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
    readonly request: ToolApprovalRequest
    readonly onResolve: (
        approvalId: string,
        decision: ToolApprovalDecision,
        beforeResolve?: () => boolean,
    ) => void
    readonly onError: (error: unknown) => void
    readonly resolveKeyboardAction: (
        key: KeyEvent,
    ) => TToolApprovalKeyboardAction | undefined
}

export interface IToolApprovalAction {
    readonly label: string
    readonly decision: ToolApprovalDecision
}

export const PATCH_APPROVAL_ACTIONS: readonly IToolApprovalAction[] = [
    { label: "Reject", decision: "reject" },
    { label: "Apply", decision: "approve" },
]

export const COMMAND_APPROVAL_ACTIONS: readonly IToolApprovalAction[] = [
    { label: "Copy", decision: "copy" },
    { label: "Run once", decision: "approve" },
    { label: "Reject", decision: "reject" },
]

export function getToolApprovalActions(
    request: ToolApprovalRequest,
): readonly IToolApprovalAction[] {
    return request.kind === "patch"
        ? PATCH_APPROVAL_ACTIONS
        : COMMAND_APPROVAL_ACTIONS
}
