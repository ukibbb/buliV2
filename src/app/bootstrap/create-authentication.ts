import {
    AuthenticationService,
    FileAuthStore,
    type IAuthenticationService,
} from "@/authentication"
import {
    OpenAiAuth,
    type IOpenAiAuth,
    type IOpenAiAuthOptions,
} from "@/providers/openai"

import { KimiAuth } from "@/providers/kimi"
import { DeepSeekAuth } from "@/providers/deepseek"

export interface IAuthenticationComposition {
    readonly service: IAuthenticationService
    readonly openAi: IOpenAiAuth
    readonly kimi: KimiAuth
    readonly deepseek: DeepSeekAuth
}

/** Builds the complete authentication feature and retains provider ownership. */
export function createAuthentication(
    options: IOpenAiAuthOptions = {},
): IAuthenticationComposition {
    const store = options.store ?? new FileAuthStore()
    const openAi = new OpenAiAuth({ ...options, store })
    const kimi = new KimiAuth({
        store,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    const deepseek = new DeepSeekAuth({
        store,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    return {
        openAi,
        kimi,
        deepseek,
        service: new AuthenticationService([openAi, kimi, deepseek]),
    }
}
