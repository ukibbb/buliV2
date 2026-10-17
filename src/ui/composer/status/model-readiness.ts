import type { IBuliApplicationSnapshot } from "@/app/contracts"

type TModelReadinessSource = Pick<
    IBuliApplicationSnapshot,
    "models" | "selection" | "selectedModelAvailable" | "modelCatalog" | "providerCatalogs"
>

interface ICatalogNotice {
    readonly message: string
    readonly severity: "error" | "warning"
}

interface IProviderWarning {
    readonly providerId: string
    readonly message: string
}

interface IModelReadiness {
    readonly selectedModelName: string
    readonly reasoningEffort: string
    readonly catalogNotice: ICatalogNotice | null
    readonly providerWarnings: readonly IProviderWarning[]
}

const LOADING_MODEL_NAME = "Loading models"
const UNAVAILABLE_MODEL_NAME = "Model unavailable"
const UNAVAILABLE_REASONING_EFFORT = "--"
const LOADING_CATALOG_MESSAGE = "Loading available account models..."
const STALE_CATALOG_SUFFIX = " Using the previous catalog."

/** Derive display text and severity without subscriptions, layout or theme colors. */
export function getModelReadiness(source: TModelReadinessSource, inputError: string | null): IModelReadiness {
    // An explicit availability decision takes precedence over catalog readiness.
    const modelAvailable = source.selectedModelAvailable
        ?? (source.modelCatalog === undefined || source.modelCatalog.status === "ready")

    return {
        selectedModelName: getSelectedModelName(source, modelAvailable),
        reasoningEffort: modelAvailable ? source.selection.reasoningEffort : UNAVAILABLE_REASONING_EFFORT,
        catalogNotice: getCatalogNotice(source.modelCatalog, inputError),
        providerWarnings: getProviderWarnings(source.providerCatalogs),
    }
}

function getSelectedModelName(source: TModelReadinessSource, modelAvailable: boolean): string {
    if (!modelAvailable) {
        return source.modelCatalog?.status === "loading" ? LOADING_MODEL_NAME : UNAVAILABLE_MODEL_NAME
    }
    const selectedModel = source.models.find((model) => model.id === source.selection.modelId)
    return selectedModel?.name ?? source.selection.modelId
}

function getCatalogNotice(
    catalog: TModelReadinessSource["modelCatalog"],
    inputError: string | null,
): ICatalogNotice | null {
    const message = catalog?.message
        ?? (catalog?.status === "loading" ? LOADING_CATALOG_MESSAGE : undefined)
    if (!message || message === inputError) return null
    return { message, severity: catalog?.status === "error" ? "error" : "warning" }
}

function getProviderWarnings(catalogs: TModelReadinessSource["providerCatalogs"]): readonly IProviderWarning[] {
    return (catalogs ?? [])
        .filter((provider) => provider.status === "error")
        .map((provider) => ({
            providerId: provider.providerId,
            message: `${provider.message ?? ""}${provider.stale ? STALE_CATALOG_SUFFIX : ""}`,
        }))
}
