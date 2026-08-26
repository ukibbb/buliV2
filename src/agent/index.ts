/** Public agent feature API used by sessions, adapters and application composition. */
export { Agent } from "@/agent/agent"
export { isImmutableAssistantSnapshot } from "@/agent/assistant-message-builder"
export { systemPrompt } from "@/agent/system-prompt"
export type { IWorkspaceInstructions } from "@/agent/system-prompt"
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
    IUserImageAttachment,
    IUserInput,
    IUserMessage,
    IUserPathReference,
    IUserSourceText,
    TAgentMessage,
    TAssistantContent,
    TUserInput,
    TUserMessageSource,
} from "@/agent/messages"
export {
    USER_IMAGE_ATTACHMENTS_MAX,
    USER_IMAGE_MAX_BYTES,
    USER_IMAGE_TOTAL_MAX_BYTES,
    USER_PATH_REFERENCES_PER_MESSAGE_MAX,
    USER_PATH_REFERENCES_PER_SESSION_MAX,
} from "@/agent/messages"
export { isValidUserImage } from "@/agent/user-image"
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
