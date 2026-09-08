export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
export const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
export const OPENAI_OAUTH_CALLBACK_URL = "http://localhost:1455/auth/callback"
export const OPENAI_OAUTH_DEVICE_USER_CODE_URL =
    "https://auth.openai.com/api/accounts/deviceauth/usercode"
export const OPENAI_OAUTH_DEVICE_TOKEN_URL =
    "https://auth.openai.com/api/accounts/deviceauth/token"
export const OPENAI_OAUTH_DEVICE_AUTHORIZATION_URL =
    "https://auth.openai.com/codex/device"
export const OPENAI_OAUTH_DEVICE_REDIRECT_URL =
    "https://auth.openai.com/deviceauth/callback"
export const OPENAI_OAUTH_ORIGINATOR = "buli"
export const OPENAI_CODEX_CLIENT_VERSION = "0.144.1"
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
export const OPENAI_CODEX_MODELS_URL =
    `${OPENAI_CODEX_BASE_URL}/models?client_version=${OPENAI_CODEX_CLIENT_VERSION}`
export const OPENAI_CODEX_RESPONSES_URL =
    "https://chatgpt.com/backend-api/codex/responses"
export const OPENAI_CODEX_SEARCH_URL =
    "https://chatgpt.com/backend-api/codex/alpha/search"
export const OPENAI_OAUTH_DUMMY_API_KEY = "buli-oauth-dummy-key"
export const MODELS_DEV_API_URL = "https://models.dev/api.json"
export const OPENAI_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
export const OPENAI_MODEL_CATALOG_TIMEOUT_MS = 10 * 1000

// Verified native Astra settings, shared by provisional startup and sparse
// account metadata fallback. They never grant account availability, Fast, or a
// context window. Codex's default effort is low; none/ultra are not native efforts.
// https://developers.openai.com/api/docs/models/gpt-6-astra.md (2026-09-07)
export const DEFAULT_OPENAI_MODEL_ID = "gpt-6-astra"
export const DEFAULT_OPENAI_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
