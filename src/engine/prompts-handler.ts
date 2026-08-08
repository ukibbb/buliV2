import type { SessionEngine } from "@/engine/session-engine"
import type { IBuliPromptInput } from "@/runtime"

type TBuliPromptSessionPort = Pick<SessionEngine, "prompt">

interface IBuliPromptsHandlerOptions {
  sessions: TBuliPromptSessionPort
}

export class BuliPromptsHandler {
  readonly sessions: TBuliPromptSessionPort

  constructor(options: IBuliPromptsHandlerOptions) {
    this.sessions = options.sessions
  }

  async submitPrompt(input: IBuliPromptInput): Promise<void> {
    await this.sessions.prompt({
      sessionId: input.sessionId,
      parts: [{ type: "text", text: input.text }],
    })
  }
}
