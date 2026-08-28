import type { IBuliApplication } from "@/app/contracts"
import { BuliUiStateStore } from "@/app/ui/controller/state"
import type { TToolApprovalDecision } from "@/agent"

interface IBuliToolApprovalOptions {
    readonly application: IBuliApplication
    readonly store: BuliUiStateStore
    readonly activeSessionId: () => string | null
}

/** Validates and resolves the active session's tool approval request. */
export class BuliToolApproval {
    private readonly application: IBuliApplication
    private readonly store: BuliUiStateStore
    private readonly activeSessionId: () => string | null
    private resolutionPending = false

    constructor(options: IBuliToolApprovalOptions) {
        this.application = options.application
        this.store = options.store
        this.activeSessionId = options.activeSessionId
    }

    readonly resolve = (
        approvalId: string,
        decision: TToolApprovalDecision,
        beforeResolve?: () => boolean,
    ): void => {
        if (this.store.isDisposed || this.resolutionPending) return
        this.resolutionPending = true
        try {
            const sessionId = this.activeSessionId()
            if (!sessionId) {
                throw new Error("Tool approval requires an active session")
            }

            const request = this.application
                .openSession(sessionId)
                .getSnapshot()
                .pendingToolApproval
            if (!request) throw new Error("No tool approval is pending")
            if (request.id !== approvalId) {
                throw new Error(
                    `Tool approval ID mismatch: expected "${request.id}", received "${approvalId}"`,
                )
            }
            if (request.sessionId !== sessionId) {
                throw new Error(
                    `Tool approval session mismatch: expected "${sessionId}", received "${request.sessionId}"`,
                )
            }
            if (beforeResolve && !beforeResolve()) return

            this.application.resolveToolApproval(sessionId, approvalId, decision)
            if (this.store.getSnapshot().inputError !== null) {
                this.store.setSnapshot({
                    ...this.store.getSnapshot(),
                    inputError: null,
                })
            }
        } catch (error) {
            this.store.setInputError(error)
        } finally {
            this.resolutionPending = false
        }
    }
}
