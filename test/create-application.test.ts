import { expect, test } from "bun:test"

import type { IAgentModelRequest } from "@/agent"
import { createBuliApplication } from "@/app/bootstrap/create-application"
import { InMemorySessionManager } from "@/sessions"

test("does not attach OpenAI web search to an injected provider-neutral model", async () => {
  let modelRequest: IAgentModelRequest | undefined
  const startup = await createBuliApplication({
    signal: new AbortController().signal,
    manager: new InMemorySessionManager(),
    model: {
      async *stream(request) {
        modelRequest = request
        yield { type: "finish", reason: "stop" }
      },
    },
  })

  try {
    const submission = startup.runtime.submitPrompt({ text: "Search the web" })
    await submission.accepted
    await submission.settled

    if (!modelRequest) throw new Error("Expected one model request")
    expect(modelRequest.tools.map((tool) => tool.name)).not.toContain("web_search")
    expect(modelRequest.systemPrompt).not.toContain("web_search")
    const assistant = startup.runtime
      .openSession(submission.sessionId)
      .getSnapshot()
      .messages.find((message) => message.role === "assistant")
    expect(assistant).not.toHaveProperty("model")
  } finally {
    await startup.dispose()
  }
})
