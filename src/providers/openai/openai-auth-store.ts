import { randomUUID } from "node:crypto"
import {
  chmod,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import {
  defaultAuthFilePath,
  type IAuthStore,
  type TAuthInfo,
} from "@/providers/auth-store"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseAuthInfo(providerID: string, value: unknown): TAuthInfo {
  if (!isRecord(value)) {
    throw new TypeError(`Invalid ${providerID} authentication: expected an object`)
  }

  if (value.type !== "oauth") {
    throw new TypeError(
      `Invalid ${providerID} authentication: only OAuth credentials are supported`,
    )
  }

  if (
    typeof value.access === "string"
    && value.access.length > 0
    && typeof value.refresh === "string"
    && value.refresh.length > 0
    && typeof value.expires === "number"
    && Number.isFinite(value.expires)
    && value.expires >= 0
    && (
      value.accountId === undefined
      || (typeof value.accountId === "string" && value.accountId.length > 0)
    )
    && (
      value.enterpriseUrl === undefined
      || (typeof value.enterpriseUrl === "string" && value.enterpriseUrl.length > 0)
    )
  ) {
    return {
      type: "oauth",
      access: value.access,
      refresh: value.refresh,
      expires: value.expires,
      ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
      ...(typeof value.enterpriseUrl === "string"
        ? { enterpriseUrl: value.enterpriseUrl }
        : {}),
    }
  }

  throw new TypeError(`Invalid ${providerID} OAuth authentication`)
}

export class OpenAiAuthStore implements IAuthStore {
  constructor(private readonly path = defaultAuthFilePath()) {}

  async all(): Promise<Record<string, TAuthInfo>> {
    const source = await this.readAuthFile()

    return Object.fromEntries(
      Object.entries(source).map(([providerID, info]) => [
        providerID,
        parseAuthInfo(providerID, info),
      ]),
    )
  }

  async get(providerID: string): Promise<TAuthInfo | undefined> {
    return (await this.all())[providerID]
  }

  async set(providerID: string, info: TAuthInfo): Promise<void> {
    const next = {
      ...(await this.all()),
      [providerID]: parseAuthInfo(providerID, info),
    }
    const directory = dirname(this.path)
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    )

    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private async readAuthFile(): Promise<Record<string, unknown>> {
    const file = Bun.file(this.path)
    if (!(await file.exists())) return {}

    try {
      const value: unknown = JSON.parse(await file.text())
      if (!isRecord(value)) {
        throw new TypeError("expected a top-level object")
      }
      return value
    } catch (cause) {
      throw new Error(`Unable to read authentication from ${this.path}`, { cause })
    }
  }
}
