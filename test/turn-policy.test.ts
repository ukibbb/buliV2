import { expect, test } from "bun:test"

import {
  type IAgentTool,
  type IUserMessage,
  PATCH_HANDOFF_CONFIRMATION_QUESTION,
} from "@/agent"
import {
  buildAgentTurnSystemPrompt,
  createAgentTurnAuthorization,
  resolveAgentTurnPolicy,
} from "@/agent/turn-policy"
import { confirmedPatchHandoffMessages } from "./support/patch-handoff"

test.each([
  "Explain this function",
  "Could you take over this implementation?",
  "Pokaż pełny kod parsera",
  "Uruchom testy",
] as const)("leaves natural-language intent inference to the model for %p", (content) => {
  expect(resolveAgentTurnPolicy(userMessage(content)).intent).toBe("coach")
})

test("keeps action authorization scoped and consumable", () => {
  const patch = actionTool("apply_patch", "patch")
  const command = actionTool("bash", "command")
  const read = readTool()
  const authorization = createAgentTurnAuthorization(
    userMessage("Tak, proszę."),
    confirmedPatchHandoffMessages(),
  )

  expect(authorization.allowsTool(read)).toBe(true)
  expect(authorization.allowsTool(patch)).toBe(true)
  expect(authorization.allowsTool(command)).toBe(false)
  expect(authorization.consumeApproval(patch, "patch")).toBe(true)
  expect(authorization.allowsTool(patch)).toBe(false)
  expect(authorization.consumeApproval(patch, "patch")).toBe(false)
})

test("keeps a patch request non-mutating until the recorded question is confirmed", () => {
  const patch = actionTool("apply_patch", "patch")
  const handoff = { ...readTool(), name: "request_patch_handoff" }

  const request = createAgentTurnAuthorization(
    userMessage("Could you handle the parser changes for me?"),
  )
  const unpromptedConfirmation = createAgentTurnAuthorization(
    userMessage("tak"),
  )
  const confirmationWithoutQuestion = createAgentTurnAuthorization(
    userMessage("tak"),
    confirmedPatchHandoffMessages().slice(0, -1),
  )
  const confirmationAfterUnrelatedText = createAgentTurnAuthorization(
    userMessage("tak"),
    [
      ...confirmedPatchHandoffMessages().slice(0, -1),
      {
        id: "unrelated-assistant",
        sessionId: "session-1",
        runId: "patch-handoff-run",
        role: "assistant",
        content: [{ type: "text" as const, text: "Dziękuję za informację." }],
        stopReason: "stop",
        createdAt: 4,
      },
    ],
  )
  const staleConfirmation = createAgentTurnAuthorization(
    userMessage("tak"),
    [
      ...confirmedPatchHandoffMessages(),
      { ...userMessage("Nowy temat"), id: "newer-user" },
    ],
  )
  const queuedConfirmation = createAgentTurnAuthorization(
    userMessage("tak", "followUp"),
    confirmedPatchHandoffMessages(),
  )
  const naturalRequestHistory = [...confirmedPatchHandoffMessages()]
  naturalRequestHistory[0] = {
    ...userMessage("Explain the parser"),
    id: "natural-handoff-origin",
  }
  const confirmationAfterNaturalRequest = createAgentTurnAuthorization(
    userMessage("tak"),
    naturalRequestHistory,
  )
  const scopeQuestionHistory = [
    ...confirmedPatchHandoffMessages().slice(0, -1),
    {
      id: "scope-question",
      sessionId: "session-1",
      runId: "patch-handoff-run",
      role: "assistant" as const,
      content: [{
        type: "text" as const,
        text: "Czy patch ma obejmować testy, czy nie? Odpowiedz tak albo nie.",
      }],
      stopReason: "stop",
      createdAt: 4,
    },
  ]
  const confirmationAfterScopeQuestion = createAgentTurnAuthorization(
    userMessage("tak"),
    scopeQuestionHistory,
  )
  const retractedQuestionHistory = [
    ...confirmedPatchHandoffMessages().slice(0, -1),
    {
      id: "retracted-question",
      sessionId: "session-1",
      runId: "patch-handoff-run",
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: PATCH_HANDOFF_CONFIRMATION_QUESTION },
        { type: "text" as const, text: "Jednak nie kontynuuj." },
      ],
      stopReason: "stop",
      createdAt: 4,
    },
  ]
  const confirmationAfterRetraction = createAgentTurnAuthorization(
    userMessage("tak"),
    retractedQuestionHistory,
  )
  const duplicateHandoff = createAgentTurnAuthorization(
    userMessage("tak"),
    [
      ...confirmedPatchHandoffMessages().slice(0, -1),
      {
        id: "duplicate-handoff-call",
        sessionId: "session-1",
        runId: "patch-handoff-run",
        role: "assistant",
        content: [{
          type: "toolCall",
          toolCallId: "duplicate-handoff-tool-call",
          toolName: "request_patch_handoff",
          input: { scope: "Another scope" },
        }],
        stopReason: "tool-calls",
        createdAt: 4,
      },
      {
        id: "duplicate-handoff-result",
        sessionId: "session-1",
        runId: "patch-handoff-run",
        role: "toolResult",
        toolCallId: "duplicate-handoff-tool-call",
        toolName: "request_patch_handoff",
        content: "Patch handoff requested: Another scope",
        isError: false,
        outcome: "completed",
        createdAt: 5,
      },
      {
        id: "duplicate-handoff-question",
        sessionId: "session-1",
        runId: "patch-handoff-run",
        role: "assistant",
        content: [{
          type: "text",
          text: "Przygotować patch w tym zakresie? Odpowiedz tak albo nie.",
        }],
        stopReason: "stop",
        createdAt: 6,
      },
    ],
  )

  const command = actionTool("bash", "command")
  expect(request.policy.intent).toBe("coach")
  expect(request.allowsTool(patch)).toBe(false)
  expect(request.allowsTool(handoff)).toBe(true)
  expect(request.allowsTool(command)).toBe(true)
  expect(request.consumeToolCall(handoff)).toBe(true)
  expect(request.allowsTool(handoff)).toBe(false)
  expect(request.allowsTool(command)).toBe(false)
  expect(request.consumeToolCall(handoff)).toBe(false)
  expect(unpromptedConfirmation.policy.intent).toBe("coach")
  expect(unpromptedConfirmation.allowsTool(patch)).toBe(false)
  expect(confirmationWithoutQuestion.policy.intent).toBe("coach")
  expect(confirmationWithoutQuestion.allowsTool(patch)).toBe(false)
  expect(confirmationAfterUnrelatedText.policy.intent).toBe("coach")
  expect(confirmationAfterUnrelatedText.allowsTool(patch)).toBe(false)
  expect(staleConfirmation.policy.intent).toBe("coach")
  expect(staleConfirmation.allowsTool(patch)).toBe(false)
  expect(queuedConfirmation.policy.intent).toBe("coach")
  expect(queuedConfirmation.allowsTool(patch)).toBe(false)
  expect(confirmationAfterNaturalRequest.policy.intent).toBe("patch")
  expect(confirmationAfterNaturalRequest.allowsTool(patch)).toBe(true)
  expect(confirmationAfterScopeQuestion.policy.intent).toBe("coach")
  expect(confirmationAfterScopeQuestion.allowsTool(patch)).toBe(false)
  expect(confirmationAfterRetraction.policy.intent).toBe("coach")
  expect(confirmationAfterRetraction.allowsTool(patch)).toBe(false)
  expect(duplicateHandoff.policy.intent).toBe("coach")
  expect(duplicateHandoff.allowsTool(patch)).toBe(false)
})

test("consumes handoff availability when command approval starts", () => {
  const authorization = createAgentTurnAuthorization(
    userMessage("Run the tests and continue based on the result"),
  )
  const command = actionTool("bash", "command")
  const handoff = { ...readTool(), name: "request_patch_handoff" }

  expect(authorization.allowsTool(command)).toBe(true)
  expect(authorization.allowsTool(handoff)).toBe(true)
  expect(authorization.consumeToolCall(command)).toBe(true)
  expect(authorization.consumeApproval(command, "command")).toBe(true)
  expect(authorization.allowsTool(command)).toBe(false)
  expect(authorization.allowsTool(handoff)).toBe(false)
})

test.each(["steer", "followUp"] as const)(
  "does not create capabilities from %s messages",
  (source) => {
    const authorization = createAgentTurnAuthorization(
      userMessage("Please implement this and run tests", source),
    )
    expect(authorization.policy.intent).toBe("coach")
    expect(authorization.allowsTool({
      ...readTool(),
      name: "request_patch_handoff",
    })).toBe(false)
    expect(authorization.allowsTool(actionTool("bash", "command"))).toBe(false)
  },
)

test("adds turn instructions without changing the supplied base prompt", () => {
  const basePrompt = "Existing system prompt"
  const authorization = createAgentTurnAuthorization(
    userMessage("Explain the parser"),
  )
  const prompt = buildAgentTurnSystemPrompt(
    basePrompt,
    authorization,
    [readTool()],
  )

  expect(prompt).toStartWith(`${basePrompt}\n\n`)
  expect(prompt).toContain("Faktycznie aktywne narzędzia w tym turnie: read.")
  expect(prompt).toContain("Interpretuj naturalnie")
  expect(prompt).toContain("nie musi używać specjalnych fraz ani prefiksów")
})

function userMessage(
  content: string,
  source: IUserMessage["source"] = "prompt",
): IUserMessage {
  return {
    id: "user-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "user",
    source,
    content,
    createdAt: 1,
  }
}

function readTool(): IAgentTool {
  return {
    name: "read",
    description: "Read",
    inputSchema: { type: "object" },
    execute: async () => "read",
  }
}

function actionTool(
  name: string,
  approvalKind: "patch" | "command",
): IAgentTool {
  return {
    name,
    approvalKind,
    description: name,
    inputSchema: { type: "object" },
    execute: async () => name,
  }
}
