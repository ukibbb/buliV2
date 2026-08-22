/** Public composition entry point for the Buli application. */
export { createBuliApplication } from "@/app/bootstrap/create-application"
export type {
    IBuliApplicationOptions,
    IBuliApplicationStartup,
} from "@/app/bootstrap/create-application"

export type {
    IBuliAgentDisplayInfo,
    IBuliApplication,
    IBuliApplicationSnapshot,
    IBuliModelDisplayInfo,
    IBuliModelSelection,
    IBuliPromptInput,
    IBuliPromptSubmission,
    IBuliQueuedMessages,
    IBuliSessionCreationOptions,
    ISnapshotSource,
} from "@/app/contracts"

export type { ISessionInfo } from "@/sessions"
