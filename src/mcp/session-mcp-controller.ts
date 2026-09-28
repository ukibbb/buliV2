import type { IAgentToolContext, IRuntimeAgentTool } from "@/agent"
import type { ISessionConfiguration } from "@/sessions"

export interface IMcpSessionContribution {
    readonly instructions: string
    readonly tools: readonly IRuntimeAgentTool[]
}

interface ISessionMcpControllerOptions {
    readonly baseConfiguration: ISessionConfiguration
    readonly applyConfiguration: (configuration: ISessionConfiguration) => void
    /** The host must reject closed sessions, wrong session IDs and disallowed tools. */
    readonly assertToolExecutionAllowed: (
        tool: IRuntimeAgentTool,
        context: IAgentToolContext,
    ) => void
}

const INSTRUCTION_SEPARATOR = "\n\n"

/** Owns MCP activation for one live session; transport ownership belongs to the host. */
export class SessionMcpController {
    private readonly baseConfiguration: ISessionConfiguration
    private registrations = new Map<string, IMcpSessionContribution>()
    private changingConfiguration = false
    private disposed = false

    constructor(private readonly options: ISessionMcpControllerOptions) {
        this.baseConfiguration = {
            systemPrompt: options.baseConfiguration.systemPrompt,
            tools: [...options.baseConfiguration.tools],
        }
    }

    isActive(serverId: string): boolean {
        return !this.disposed && this.registrations.has(serverId)
    }

    activate(serverId: string, contribution: IMcpSessionContribution): void {
        this.assertCanChange()
        if (!serverId.trim()) throw new Error("MCP server ID cannot be empty")
        if (this.isActive(serverId)) return
        const registration: IMcpSessionContribution = {
            instructions: contribution.instructions,
            tools: contribution.tools.map((tool): IRuntimeAgentTool => ({
                ...tool,
                validateAndExecute: async (input, context) => {
                    if (this.disposed || this.changingConfiguration
                        || this.registrations.get(serverId) !== registration) {
                        throw new Error(`MCP server "${serverId}" is inactive`)
                    }
                    this.options.assertToolExecutionAllowed(tool, context)
                    return tool.validateAndExecute(input, context)
                },
            })),
        }
        const next = new Map(this.registrations)
        next.set(serverId, registration)
        this.apply(next)
    }

    deactivate(serverId: string): void {
        this.assertCanChange()
        if (!this.isActive(serverId)) return
        const next = new Map(this.registrations)
        next.delete(serverId)
        this.apply(next)
    }

    /** Revokes executors during host shutdown; does not update a closing session. */
    dispose(): void {
        if (this.disposed) return
        this.assertCanChange()
        this.disposed = true
        this.registrations.clear()
    }

    private apply(next: Map<string, IMcpSessionContribution>): void {
        const configuration = this.composeConfiguration(next)
        const previous = this.registrations
        this.changingConfiguration = true
        this.registrations = next
        try {
            this.options.applyConfiguration(configuration)
        } catch (error) {
            this.registrations = previous
            throw error
        } finally {
            this.changingConfiguration = false
        }
    }

    private composeConfiguration(
        registrations: ReadonlyMap<string, IMcpSessionContribution>,
    ): ISessionConfiguration {
        const contributions = [...registrations.values()]
        const tools = [
            ...this.baseConfiguration.tools,
            ...contributions.flatMap((contribution) => contribution.tools),
        ]
        const names = new Set<string>()
        for (const tool of tools) {
            if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`)
            names.add(tool.name)
        }
        return {
            systemPrompt: [
                this.baseConfiguration.systemPrompt,
                ...contributions.map((contribution) => contribution.instructions),
            ].filter((instructions) => instructions.length > 0).join(INSTRUCTION_SEPARATOR),
            tools,
        }
    }

    private assertCanChange(): void {
        if (this.disposed) throw new Error("Session MCP controller is disposed")
        if (this.changingConfiguration) throw new Error("MCP configuration update is in progress")
    }
}
