import type {
  ICreateSessionInput,
  ISessionEngineOptions,
  ISessionPromptInput,
} from "@/runtime"
import type { IBuliMessage } from "@/engine/interaction-driver"
import type { IUserBuliInteractionDriver, IUserBuliInteraction } from "@/engine/interaction-driver"
import type { AIModel } from "@/providers/common-types"

export interface Session {
  id: string
  title: string
  model: AIModel
  createdAt: AIModel
}

export class SessionEngine {
  driver: IUserBuliInteractionDriver
  constructor(options: ISessionEngineOptions) {
    this.driver = options.driver
  }

  async prompt(input: ISessionPromptInput): Promise<IBuliMessage | undefined> {
    return
  }

  async get(sessionId: string) {
    return
  }
  async create(session: ICreateSessionInput) { }
  async updateSelectedModel() { }

  private async handleUserBuliInteraction(interaction: IUserBuliInteraction) { }
  private async handleInteraction() {
    while (true) { }
  }
  private async runInteraction() { }
  private async handleInteractionEvent() { }
}
