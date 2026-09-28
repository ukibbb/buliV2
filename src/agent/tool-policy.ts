import type { IRuntimeAgentTool } from "@/agent/tool"

export const ToolAccess = {
    ReadOnly: "read-only",
    MayMutate: "may-mutate",
} as const

export type TToolAccess = (typeof ToolAccess)[keyof typeof ToolAccess]

export type ToolSource =
    | { readonly kind: "local" }
    | { readonly kind: "mcp"; readonly serverId: string }

export interface ToolPolicyContext {
    readonly tool: { readonly name: string; readonly access: TToolAccess }
    readonly source: ToolSource
}

export type ToolPolicyDecision =
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: string }

export type ToolPolicyEvaluator = (context: ToolPolicyContext) => ToolPolicyDecision

/** Register policies here; configuration IDs are derived from this registry. */
export const toolPolicies = {
    full: (_context: ToolPolicyContext) => ({ allowed: true }),
    "read-only": ({ tool }: ToolPolicyContext) => tool.access === ToolAccess.ReadOnly
        ? { allowed: true }
        : { allowed: false, reason: "Ta polityka dopuszcza wyłącznie odczyt." },
} satisfies Record<string, ToolPolicyEvaluator>

export type TToolPolicy = keyof typeof toolPolicies

export const ToolPolicy = {
    Full: "full",
    ReadOnly: "read-only",
} as const satisfies Record<string, TToolPolicy>

export interface ToolSourceBinding {
    readonly source: ToolSource
    readonly toolName: string
    readonly policy: TToolPolicy
}

/** A branch can restrict a source policy, but cannot grant additional access. */
export function evaluateToolAccess(
    tool: IRuntimeAgentTool,
    branchPolicy: TToolPolicy,
): ToolPolicyDecision {
    const context: ToolPolicyContext = {
        tool: {
            name: tool.sourceBinding?.toolName ?? tool.name,
            access: tool.access ?? ToolAccess.MayMutate,
        },
        source: tool.sourceBinding?.source ?? { kind: "local" },
    }
    const sourceDecision = evaluatePolicy(tool.sourceBinding?.policy ?? ToolPolicy.Full, context)
    if (!sourceDecision.allowed) return sourceDecision
    return evaluatePolicy(branchPolicy, context)
}

function evaluatePolicy(policy: TToolPolicy, context: ToolPolicyContext): ToolPolicyDecision {
    if (!Object.hasOwn(toolPolicies, policy)) {
        return { allowed: false, reason: "Nieznana polityka narzędzi." }
    }
    return toolPolicies[policy](context)
}

export function isToolAllowed(tool: IRuntimeAgentTool, policy: TToolPolicy): boolean {
    return evaluateToolAccess(tool, policy).allowed
}
