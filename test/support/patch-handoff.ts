import {
  PATCH_HANDOFF_CONFIRMATION_QUESTION,
  PATCH_HANDOFF_TOOL_NAME,
  type TAgentMessage,
} from "@/agent"

export function confirmedPatchHandoffMessages(
  sessionId = "session-1",
): readonly TAgentMessage[] {
  return [
    {
      id: "patch-handoff-user",
      sessionId,
      runId: "patch-handoff-run",
      role: "user",
      source: "prompt",
      content: "Przejmij proszę implementację parsera",
      createdAt: 1,
    },
    {
      id: "patch-handoff-call",
      sessionId,
      runId: "patch-handoff-run",
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "patch-handoff-tool-call",
        toolName: PATCH_HANDOFF_TOOL_NAME,
        input: { scope: "Implement parser changes" },
      }],
      stopReason: "tool-calls",
      createdAt: 2,
    },
    {
      id: "patch-handoff-result",
      sessionId,
      runId: "patch-handoff-run",
      role: "toolResult",
      toolCallId: "patch-handoff-tool-call",
      toolName: PATCH_HANDOFF_TOOL_NAME,
      content: "Patch handoff requested: Implement parser changes",
      isError: false,
      outcome: "completed",
      createdAt: 3,
    },
    {
      id: "patch-handoff-question",
      sessionId,
      runId: "patch-handoff-run",
      role: "assistant",
      content: [{
        type: "text",
        text: PATCH_HANDOFF_CONFIRMATION_QUESTION,
      }],
      stopReason: "stop",
      createdAt: 4,
    },
  ]
}
