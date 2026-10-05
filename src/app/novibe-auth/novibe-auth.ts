import { createHash, randomBytes } from "node:crypto"
import type { OAuthClientProvider } from "@modelcontextprotocol/client"
import { FileAuthStore, type IAuthStore, type IMcpOAuthCredential } from "@/authentication"
import { listenForAuthorization } from "./loopback"

const ISSUER = "http://localhost:8000"
const RESOURCE = "http://127.0.0.1:8000/mcp/"
const STORE_KEY = "novibe"
const CLIENT_ID = "buli"
const SCOPE = "novibe:mcp"

/** Owns NoVibe credentials; none of its values belong in conversation history. */
export class NovibeAuth {
    private pending: AbortController | undefined
    constructor(private readonly store: IAuthStore = new FileAuthStore(), private readonly request: typeof fetch = fetch) {}

    private credential(value: Awaited<ReturnType<IAuthStore["get"]>>): IMcpOAuthCredential | undefined {
        if (value?.type !== "mcp_oauth") return undefined
        if (value.issuer !== ISSUER || value.resource !== RESOURCE || value.clientId !== CLIENT_ID) throw new Error("NoVibe: niezgodny serwer poświadczeń.")
        return value
    }

    async login(openUrl: (url: string) => Promise<unknown>, signal: AbortSignal): Promise<string> {
        this.pending?.abort()
        const abort = new AbortController()
        this.pending = abort
        const operationSignal = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(5 * 60_000)])
        const revision = await this.store.beginOperation(STORE_KEY, operationSignal)
        const state = randomBytes(32).toString("base64url")
        const verifier = randomBytes(48).toString("base64url")
        const receiver = await listenForAuthorization(state, ISSUER, operationSignal)
        let issued: IMcpOAuthCredential | undefined
        let committed = false
        try {
            const url = new URL(`${ISSUER}/authorize`)
            url.search = new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", scope: SCOPE,
                resource: RESOURCE, state, code_challenge_method: "S256",
                code_challenge: createHash("sha256").update(verifier).digest("base64url"), redirect_uri: receiver.redirectUri }).toString()
            await openUrl(url.href)
            const code = await receiver.code
            issued = await this.exchange({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: receiver.redirectUri }, operationSignal)
            committed = await this.store.commitOperation(STORE_KEY, revision, issued, operationSignal)
            if (!committed) throw new Error("NoVibe: logowanie zostało zastąpione inną operacją.")
            return "Zalogowano do NoVibe. Narzędzia włączysz poleceniem /novibe."
        } finally {
            await receiver.close()
            if (issued && !committed) await this.revoke(issued.refresh).catch(() => {})
            if (this.pending === abort) this.pending = undefined
        }
    }

    private async exchange(parameters: Record<string, string>, signal: AbortSignal): Promise<IMcpOAuthCredential> {
        const response = await this.request(`${ISSUER}/token`, {
            method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            body: new URLSearchParams({ ...parameters, client_id: CLIENT_ID, resource: RESOURCE }),
        })
        if (!response.ok) throw new Error("NoVibe: token odrzucony. Uruchom /novibe login.")
        const data: unknown = await response.json()
        if (typeof data !== "object" || data === null) throw new Error("Invalid NoVibe token response")
        const token = data as Record<string, unknown>
        if (typeof token.access_token !== "string" || !token.access_token || typeof token.refresh_token !== "string" || !token.refresh_token
            || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0
            || token.token_type !== "Bearer" || token.scope !== SCOPE) throw new Error("Invalid NoVibe token response")
        return { type: "mcp_oauth", issuer: ISSUER, resource: RESOURCE, clientId: CLIENT_ID,
            access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000 }
    }

    async access(signal: AbortSignal): Promise<IMcpOAuthCredential> {
        const stored = this.credential(await this.store.get(STORE_KEY, signal))
        if (!stored) throw new Error("NoVibe: najpierw uruchom /novibe login.")
        if (stored.expires > Date.now() + 30_000) return stored
        // modify holds the existing cross-process file lock through refresh and save.
        const refreshed = await this.store.modify(STORE_KEY, async current => {
            const credential = this.credential(current)
            if (!credential) throw new Error("NoVibe: wylogowano.")
            return credential.expires > Date.now() + 30_000 ? credential
                : this.exchange({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal)
        }, signal)
        const credential = this.credential(refreshed)
        if (!credential) throw new Error("NoVibe: wylogowano.")
        return credential
    }

    async status(signal: AbortSignal): Promise<string> {
        if (!this.credential(await this.store.get(STORE_KEY, signal))) return "NoVibe: niezalogowano."
        const credential = await this.access(signal)
        const response = await this.request(`${ISSUER}/auth/mcp/status`, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { Authorization: `Bearer ${credential.access}` } })
        if (!response.ok) throw new Error("NoVibe: nie potwierdzono dostępu do konta.")
        const data = await response.json() as { user_id?: unknown }
        if (typeof data.user_id !== "string" || !/^[0-9a-f-]{36}$/.test(data.user_id)) throw new Error("Invalid NoVibe account response")
        return `NoVibe: zalogowano. Konto ${data.user_id}.`
    }

    private async revoke(token: string): Promise<void> {
        const response = await this.request(`${ISSUER}/revoke`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), body: new URLSearchParams({ client_id: CLIENT_ID, token, token_type_hint: "refresh_token" }) })
        if (!response.ok) throw new Error("Revocation failed")
    }

    async logout(): Promise<string> {
        this.pending?.abort()
        await this.store.beginOperation(STORE_KEY)
        let confirmed = true
        await this.store.modify(STORE_KEY, async current => {
            const credential = this.credential(current)
            if (credential) await this.revoke(credential.refresh).catch(() => { confirmed = false })
            return undefined
        })
        return confirmed ? "Wylogowano Buli z NoVibe." : "Usunięto lokalne poświadczenia. Nie potwierdzono unieważnienia na serwerze."
    }

    provider(signal: AbortSignal): OAuthClientProvider {
        const interactive = () => { throw new Error("NoVibe: uruchom /novibe login.") }
        return {
            redirectUrl: undefined,
            clientMetadata: { client_name: "Buli", redirect_uris: [], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] },
            clientInformation: () => ({ client_id: CLIENT_ID, issuer: ISSUER }),
            tokens: async () => { const token = await this.access(signal); return { access_token: token.access, token_type: "Bearer", scope: SCOPE, issuer: ISSUER } },
            saveTokens: interactive,
            redirectToAuthorization: interactive,
            saveCodeVerifier: interactive,
            codeVerifier: interactive,
            validateResourceURL: async (serverUrl, resource) => {
                if (String(serverUrl) !== RESOURCE || (resource !== undefined && resource !== RESOURCE)) throw new Error("Untrusted NoVibe resource")
                return new URL(RESOURCE)
            },
        }
    }

    dispose(): void { this.pending?.abort() }
}
