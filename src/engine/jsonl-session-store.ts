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

import type { IBuliMessageWithParts, ISessionSnapshot } from "@/domain"
import {
  assertValidSessionMessage,
  InMemorySessionStore,
  type ISessionStore,
  type TSessionStoreListener,
} from "@/engine/session-store"

interface IJsonlSessionStoreOptions {
  readonly filePath: string
}

/** Persists completed conversation records while serving reactive memory snapshots. */
export class JsonlSessionStore implements ISessionStore {
  private readonly memory = new InMemorySessionStore()
  private readonly filePath: string

  constructor(options: IJsonlSessionStoreOptions) {
    this.filePath = options.filePath
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    this.load()
  }

  readonly getHistory = (
    sessionId: string,
  ): readonly IBuliMessageWithParts[] => this.memory.getHistory(sessionId)

  readonly getSnapshot = (sessionId: string): ISessionSnapshot => {
    return this.memory.getSnapshot(sessionId)
  }

  readonly publish = (message: IBuliMessageWithParts): void => {
    assertValidSessionMessage(message)

    if (shouldPersist(message)) {
      appendFileSync(this.filePath, `${JSON.stringify(message)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
    }

    this.memory.publish(message)
  }

  readonly subscribe = (
    sessionId: string,
    listener: TSessionStoreListener,
  ): (() => void) => this.memory.subscribe(sessionId, listener)

  private load(): void {
    if (!existsSync(this.filePath)) return

    const lines = readFileSync(this.filePath, "utf8").split("\n")
    const lastRecordIndex = lines.findLastIndex((line) => line.trim().length > 0)

    lines.forEach((line, index) => {
      if (!line.trim()) return

      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error) {
        // A process can stop midway through its final append. Earlier corruption is not safe to hide.
        if (index === lastRecordIndex) {
          const completeLines = lines.slice(0, index)
          writeFileSync(
            this.filePath,
            completeLines.length > 0 ? `${completeLines.join("\n")}\n` : "",
            { encoding: "utf8", mode: 0o600 },
          )
          return
        }
        throw invalidLineError(index, error)
      }

      try {
        assertValidSessionMessage(value)
      } catch (error) {
        throw invalidLineError(index, error)
      }

      this.memory.publish(value)
    })
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

function shouldPersist(message: IBuliMessageWithParts): boolean {
  // Streaming publishes many snapshots with one message ID. Persist users immediately
  // and assistants only after completion so JSONL does not grow once per token;
  // hydration still reconstructs the same final model history.
  return message.info.role === "user" || message.info.completedAt !== undefined
}

function invalidLineError(index: number, cause: unknown): Error {
  return new Error(`Invalid session JSONL record on line ${index + 1}`, { cause })
}
