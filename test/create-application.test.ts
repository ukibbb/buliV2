import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentModelRequest } from "@/agent"
import { createBuliApplication } from "@/app/bootstrap/create-application"
import { InMemorySessionManager } from "@/sessions"

test("does not attach OpenAI web search to an injected provider-neutral model", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "buli-application-"))
  await mkdir(join(workspace, ".buli"))
  await writeFile(
    join(workspace, ".buli", "AGENTS.md"),
    "Run the project checks before finishing.",
  )
  let modelRequest: AgentModelRequest | undefined
  const startup = await createBuliApplication({
    signal: new AbortController().signal,
    workspaceRoot: workspace,
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
    expect(modelRequest.systemPrompt).toContain(
      '<workspace_instructions source=".buli/AGENTS.md">',
    )
    expect(modelRequest.systemPrompt).toContain(
      "Run the project checks before finishing.",
    )
    expect(startup.runtime.workspaceRoot).toBe(await realpath(workspace))
    const assistant = startup.runtime
      .openSession(submission.sessionId)
      .getSnapshot()
      .messages.find((message) => message.role === "assistant")
    expect(assistant).not.toHaveProperty("model")
  } finally {
    await startup.dispose()
    await rm(workspace, { recursive: true, force: true })
  }
})
