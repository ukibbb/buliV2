import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { TAgentMessage } from "@/domain"
import {
  assertDurableSessionMessage,
  InMemorySessionManager,
  type ISessionManager,
} from "@/session/session-manager"

interface IJsonlSessionManagerOptions {
  readonly filePath: string
}

/** Persists direct Agent messages as one JSON object per line. */
export class JsonlSessionManager implements ISessionManager {
  private readonly memory = new InMemorySessionManager()
  private readonly filePath: string

  constructor(options: IJsonlSessionManagerOptions) {
    this.filePath = options.filePath
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    this.load()
  }

  readonly getMessages = (
    sessionId: string,
  ): readonly TAgentMessage[] => this.memory.getMessages(sessionId)

  readonly appendMessage = (message: TAgentMessage): void => {
    assertDurableSessionMessage(message)
    appendFileSync(this.filePath, `${JSON.stringify(message)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    this.memory.appendMessage(message)
  }

  readonly clearSession = (sessionId: string): void => {
    const retainedMessages = this.memory
      .getAllMessages()
      .filter((message) => message.sessionId !== sessionId)
    const contents = retainedMessages.length === 0
      ? ""
      : `${retainedMessages.map((message) => JSON.stringify(message)).join("\n")}\n`

    writeFileSync(this.filePath, contents, {
      encoding: "utf8",
      mode: 0o600,
    })
    this.memory.clearSession(sessionId)
  }

  private load(): void {
    if (!existsSync(this.filePath)) return

    const lines = readFileSync(this.filePath, "utf8").split("\n")
    const lastRecordIndex = lines.findLastIndex((line) => line.trim().length > 0)

    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue

      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error) {
        if (index === lastRecordIndex) {
          const completeLines = lines.slice(0, index)
          writeFileSync(
            this.filePath,
            completeLines.length > 0 ? `${completeLines.join("\n")}\n` : "",
            { encoding: "utf8", mode: 0o600 },
          )
          break
        }
        throw invalidLineError(index, error)
      }

      try {
        assertDurableSessionMessage(value)
      } catch (error) {
        throw invalidLineError(index, error)
      }
      this.memory.appendMessage(value)
    }
  }
}

export function defaultSessionFilePath(
  workspaceRoot = process.cwd(),
): string {
  const canonicalWorkspace = realpathSync(workspaceRoot)
  const workspaceID = createHash("sha256")
    .update(canonicalWorkspace)
    .digest("hex")
  return join(homedir(), ".buli", "sessions", `${workspaceID}.jsonl`)
}

function invalidLineError(index: number, cause: unknown): Error {
  return new Error(`Invalid session JSONL record on line ${index + 1}`, { cause })
}
