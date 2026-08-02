import { SessionEngine } from "@/engine/session-engine"

type TBuliPromptGetCreateSelectModelSessionPort = Pick<SessionEngine, "get" | "create" | "updateSelectedModel" | "prompt">

export class BuliPromptsHandler {
  sessions: TBuliPromptGetCreateSelectModelSessionPort
  constructor(sessions: TBuliPromptGetCreateSelectModelSessionPort) {
    this.sessions = sessions
  }

}
