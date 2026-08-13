import { realpath } from "node:fs/promises"

import type {
  IAgentModel,
  IAgentTool,
} from "@/agent/agent-types"
import { systemPrompt } from "@/agent/agents-prompts"
import type { ISessionSnapshot } from "@/domain"
import { OpenAiAgentModel } from "@/providers/openai/openai-agent-model"
import { AgentSession } from "@/session/agent-session"
import {
  defaultSessionFilePath,
  JsonlSessionManager,
} from "@/session/jsonl-session-manager"
import type { ISessionManager } from "@/session/session-manager"
import { createWorkspaceTools } from "@/tools/workspace-tools"

export interface ISnapshotSource<Snapshot> {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => Snapshot
}

export interface IBuliPromptInput {
  readonly sessionId: string
  readonly text: string
}

export interface IBuliApplication {
  readonly workspaceRoot: string
  readonly submitPrompt: (prompt: IBuliPromptInput) => Promise<void>
  readonly clearSession: (sessionId: string) => void
  readonly abort: (sessionId: string) => void
  readonly getAgentSession: (
    sessionId: string,
  ) => ISnapshotSource<ISessionSnapshot>
}

interface IBuliRuntimeOptions {
  readonly workspaceRoot: string
  readonly manager: ISessionManager
  readonly model: IAgentModel
  readonly tools: readonly IAgentTool[]
  readonly systemPrompt: string
}

/** Owns and reuses one AgentSession for each requested session ID. */
export class BuliApplicationRuntime implements IBuliApplication {
  readonly workspaceRoot: string
  private readonly options: IBuliRuntimeOptions
  private readonly sessions = new Map<string, AgentSession>()
  private disposed = false

  constructor(options: IBuliRuntimeOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.options = options
  }

  readonly submitPrompt = async (prompt: IBuliPromptInput): Promise<void> => {
    if (this.disposed) throw new Error("Buli runtime is disposed")

    await this.requireAgentSession(prompt.sessionId).prompt(prompt.text)
  }

  readonly clearSession = (sessionId: string): void => {
    if (this.disposed) throw new Error("Buli runtime is disposed")
    this.requireAgentSession(sessionId).clear()
  }

  readonly abort = (sessionId: string): void => {
    if (this.disposed) throw new Error("Buli runtime is disposed")
    this.sessions.get(sessionId)?.abort()
  }

  readonly getAgentSession = (
    sessionId: string,
  ): ISnapshotSource<ISessionSnapshot> => {
    if (this.disposed) throw new Error("Buli runtime is disposed")
    return this.requireAgentSession(sessionId)
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true

    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
  }

  private requireAgentSession(sessionId: string): AgentSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new AgentSession({
      sessionId,
      manager: this.options.manager,
      systemPrompt: this.options.systemPrompt,
      model: this.options.model,
      tools: this.options.tools,
    })
    this.sessions.set(sessionId, session)
    return session
  }
}

interface IBuliApplicationOptions {
  readonly signal: AbortSignal
  readonly manager?: ISessionManager
  readonly model?: IAgentModel
  readonly tools?: readonly IAgentTool[]
}

/** Composes provider, tools, persistence, sessions, and the UI boundary. */
export async function createBuliApplication(
  options: IBuliApplicationOptions,
): Promise<BuliApplicationRuntime> {
  options.signal.throwIfAborted()
  const workspaceRoot = await realpath(process.cwd())
  options.signal.throwIfAborted()

  const runtime = new BuliApplicationRuntime({
    workspaceRoot,
    manager: options.manager ?? new JsonlSessionManager({
      filePath: defaultSessionFilePath(workspaceRoot),
    }),
    model: options.model ?? new OpenAiAgentModel(),
    tools: options.tools ?? createWorkspaceTools(workspaceRoot),
    systemPrompt: systemPrompt(workspaceRoot),
  })

  options.signal.addEventListener("abort", runtime.dispose, { once: true })
  return runtime
}
