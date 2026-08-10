import { join } from "node:path"
import { homedir } from "node:os"

function buliDataDirectory() {
  return join(homedir(), ".buli")
}

export function defaultAuthFilePath(): string {
  return join(buliDataDirectory(), "auth.json")
}

export const AUTH_FILE_PATH = defaultAuthFilePath()

// OAuth style authentication where opencode has an acess token plus a refresh token and expiration type
// {
//   type: "oauth",
//   access: "access_token...",
//   refresh: "refresh_token...",
//   expires: 1786262400000,
//   accountId: "..."
// }
export interface IOAuthAuth {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export type TAuthInfo = IOAuthAuth

export interface IAuthStore {
  all(): Promise<Record<string, TAuthInfo>>
  get(providerID: string): Promise<TAuthInfo | undefined>
  set(providerID: string, info: TAuthInfo): Promise<void>
}
