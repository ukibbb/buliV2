import type { IRuntimeAgentTool } from "@/agent/tool"

export const ToolPolicy = {
    Full: "full",
    ReadOnly: "read-only",
} as const

export type TToolPolicy =
    (typeof ToolPolicy)[keyof typeof ToolPolicy]

export const ToolAccess = {
    ReadOnly: "read-only",
    MayMutate: "may-mutate",
} as const

export type TToolAccess =
    (typeof ToolAccess)[keyof typeof ToolAccess]

export function isToolAllowed(
    tool: IRuntimeAgentTool,
    policy: TToolPolicy,
): boolean {
    switch (policy) {
        case ToolPolicy.Full:
            return true
        case ToolPolicy.ReadOnly:
            return tool.access === ToolAccess.ReadOnly
        default:
            return false
    }
}
