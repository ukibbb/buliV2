/** Public agent feature API used by sessions, adapters and application composition. */
export { Agent } from "@/agent/agent"
export { systemPrompt } from "@/agent/system-prompt"
export type {
    IAgentEvent,
    TAgentCriticalEventSink,
    TAgentEventListener,
} from "@/agent/events"
export type {
    IAssistantMessage,
    IReasoningContent,
    ITextContent,
    IToolCallContent,
    IToolResultMessage,
    IUserMessage,
    TAgentMessage,
    TAssistantContent,
    TUserMessageSource,
} from "@/agent/messages"
export type {
    IAgentModel,
    IAgentModelEvent,
    IAgentModelRequest,
    IAgentRunConfiguration,
    TAgentRunConfigurationResolver,
} from "@/agent/model"
export {
    isModelContextOverflowError,
    ModelContextOverflowError,
} from "@/agent/model"
export type {
    IModelProfile,
    IModelUsage,
    TReasoningEffort,
} from "@/agent/model-values"
export type {
    IAgentContextProjection,
    IAgentLoopResult,
    IAgentRunHandle,
    IAgentState,
    TAgentRunEndReason,
    TAgentContextProjector,
} from "@/agent/state"
export type {
    IAgentTool,
    IAgentToolDescriptor,
    IAgentToolExecutionContext,
    IAgentToolExecutionResult,
    TToolApprovalKind,
    TToolExecutionOutcome,
} from "@/agent/tool"
export type {
    ICommandToolApprovalDraft,
    ICommandToolApprovalRequest,
    IPatchToolApprovalDraft,
    IPatchToolApprovalRequest,
    TToolApprovalDecision,
    TToolApprovalDraft,
    TToolApprovalRequest,
} from "@/agent/tool-approval"
