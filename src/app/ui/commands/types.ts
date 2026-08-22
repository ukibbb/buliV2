import type { IBuliApplication } from "@/app/contracts"
import type { TAuthenticationMode } from "@/authentication/ui"

export interface IBuliCommandInfo {
    readonly name: string
    readonly description: string
}

export interface IBuliCommandContext {
    readonly application: IBuliApplication
    readonly sessionId: string | null
    readonly activateSession: (sessionId: string) => void
    readonly goHome: () => void
    readonly openAuthentication: (mode: TAuthenticationMode) => void
}

export interface IBuliMenuItem {
    readonly id: string
    readonly label: string
    readonly description?: string
}

export interface IBuliPickerContent {
    readonly items: readonly IBuliMenuItem[]
    readonly selectedItemId?: string
    readonly emptyMessage?: string
}

type TBuliCommandHandler = (
    args: string,
    context: IBuliCommandContext,
) => void | Promise<void>

export type TBuliCommand = IBuliCommandInfo & (
    | {
        readonly kind: "action"
        readonly handler: TBuliCommandHandler
    }
    | {
        readonly kind: "picker"
        readonly load: (
            context: IBuliCommandContext,
        ) => IBuliPickerContent | Promise<IBuliPickerContent>
        readonly select: (
            itemId: string,
            context: IBuliCommandContext,
        ) => void | Promise<void>
    }
)
