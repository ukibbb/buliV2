import type { IAgentContextProjection, TAgentMessage } from "@/agent"
import type { ICompactionCheckpoint } from "@/sessions/compaction/checkpoint"

export type TStoredMessage = TAgentMessage

export const HISTORY_MESSAGE_TARGET = 500

export interface IHistoryCursor {
    readonly sessionId: string
    readonly branchId: string
    readonly beforeMessageId: string
}

export interface IHistoryPage {
    readonly sessionId: string
    readonly branchId: string
    readonly messages: readonly TStoredMessage[]
    readonly olderCursor?: IHistoryCursor
    readonly checkpoint?: ICompactionCheckpoint
}

export interface IRequiredContext extends IAgentContextProjection {
    readonly messages: readonly TStoredMessage[]
    readonly checkpoint?: ICompactionCheckpoint
}

export type TAppendMessageResult = { readonly kind: "inserted" | "unchanged" }
