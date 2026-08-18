import type { IAuthenticationService } from "@/auth/contracts"
import { AuthenticationService } from "@/auth/authentication-service"
import {
    OpenAiAuth,
    type IOpenAiAuth,
    type IOpenAiAuthOptions,
} from "@/providers/openai/openai-auth"

export interface IAuthenticationComposition {
    readonly service: IAuthenticationService
    readonly openAi: IOpenAiAuth
}

/** Wires concrete providers at the outer composition boundary. */
export function createAuthentication(
    options: IOpenAiAuthOptions = {},
): IAuthenticationComposition {
    const openAi = new OpenAiAuth(options)
    return {
        openAi,
        service: new AuthenticationService([openAi]),
    }
}
