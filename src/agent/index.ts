/** Public agent feature API used by sessions, adapters and application composition. */
export { Agent } from "@/agent/agent"
export type { AgentOptions } from "@/agent/agent"
export { runAgentLoop } from "@/agent/agent-loop"
export type {
    AgentApprovalContext,
    AgentApprovalHandler,
    AgentContext,
    AgentEventSink,
    AgentInputQueue,
    AgentLoopConfig,
} from "@/agent/agent-loop"
export { isImmutableAssistantSnapshot } from "@/agent/assistant-message-builder"
export { systemPrompt } from "@/agent/system-prompt"
export type { WorkspaceInstructions } from "@/agent/system-prompt"
export type {
    AgentCriticalEventSink,
    AgentEvent,
    AgentEventListener,
} from "@/agent/events"
export type {
    AgentMessage,
    AssistantContent,
    AssistantMessage,
    ReasoningContent,
    TextContent,
    ToolCallContent,
    ToolResultMessage,
    UserImageAttachment,
    UserInput,
    UserInputContent,
    UserMessage,
    UserMessageSource,
    UserPathReference,
    UserSourceText,
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
    AgentModel,
    AgentModelEvent,
    AgentModelRequest,
    AgentRunConfiguration,
    AgentRunConfigurationResolver,
} from "@/agent/model"
export {
    isModelContextOverflowError,
    ModelContextOverflowError,
} from "@/agent/model"
export type {
    ModelProfile,
    ModelUsage,
    ReasoningEffort,
} from "@/agent/model-values"
export type {
    AgentContextProjection,
    AgentContextProjector,
    AgentLoopResult,
    AgentRunEndReason,
    AgentRunHandle,
    AgentState,
} from "@/agent/state"
export type {
    AgentTool,
    AgentToolContext,
    AgentToolDescriptor,
    AgentToolResult,
    ToolApprovalKind,
    ToolExecutionOutcome,
} from "@/agent/tool"
export type {
    CommandToolApprovalDraft,
    CommandToolApprovalRequest,
    PatchToolApprovalDraft,
    PatchToolApprovalRequest,
    ToolApprovalDecision,
    ToolApprovalDraft,
    ToolApprovalRequest,
} from "@/agent/tool-approval"
