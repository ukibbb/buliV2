/** Public agent feature API used by sessions, adapters and application composition. */
export { Agent } from "@/agent/agent"
export type { IAgentOptions } from "@/agent/agent"
export { runAgentLoop } from "@/agent/agent-loop"
export type {
    IAgentApprovalContext,
    TAgentApprovalHandler,
    IAgentContext,
    TAgentEventSink,
    IAgentInputQueue,
    IAgentLoopConfig,
} from "@/agent/agent-loop"
export { isImmutableAssistantSnapshot } from "@/agent/assistant-message-builder"
export { systemPrompt } from "@/agent/system-prompt"
export type { IWorkspaceInstructions } from "@/agent/system-prompt"
export type {
    TAgentCriticalEventSink,
    TAgentEvent,
    TAgentEventListener,
} from "@/agent/events"
export type {
    IFileChangeProposal,
    IFileChangeProposalRecord,
    IFileChangeProposalSource,
    TFileChangeOperation,
    TFileChangeProposalStatus,
} from "@/agent/file-change-proposal"
export type {
    TAgentMessage,
    TAssistantContent,
    IAssistantMessage,
    IReasoningContent,
    ITextContent,
    IToolCallContent,
    IToolResultMessage,
    IUserImageAttachment,
    TUserInput,
    IUserInputContent,
    IUserMessage,
    TUserMessageSource,
    IUserPathReference,
    IUserSourceText,
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
    TAgentModelEvent,
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
    TAgentContextProjector,
    IAgentLoopResult,
    TAgentRunEndReason,
    IAgentRunHandle,
    IAgentState,
} from "@/agent/state"
export type {
    IAgentTool,
    IAgentToolContext,
    IAgentToolDescriptor,
    IAgentToolResult,
    TToolApprovalKind,
    TToolExecutionOutcome,
} from "@/agent/tool"
export { TOOL_OUTPUT_PARTS } from "@/agent/tool-output-store"
export {
    MAX_TOOL_OUTPUT_BYTES,
    MAX_TOOL_OUTPUT_LINES,
} from "@/agent/tool-output"
export type {
    IStoredToolOutput,
    IToolOutputIdentity,
    IToolOutputPage,
    IToolOutputStore,
    IToolOutputWriter,
    TToolOutputEncoding,
    TToolOutputPart,
} from "@/agent/tool-output-store"
export type {
    ICommandToolApprovalDraft,
    ICommandToolApprovalRequest,
    TToolApprovalDecision,
    TToolApprovalDraft,
    TToolApprovalRequest,
} from "@/agent/tool-approval"
