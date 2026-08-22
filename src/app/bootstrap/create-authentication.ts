import {
    AuthenticationService,
    type IAuthenticationService,
} from "@/authentication"
import {
    OpenAiAuth,
    type IOpenAiAuth,
    type IOpenAiAuthOptions,
} from "@/providers/openai"

export interface IAuthenticationComposition {
    readonly service: IAuthenticationService
    readonly openAi: IOpenAiAuth
}

/** Builds the complete authentication feature and retains provider ownership. */
export function createAuthentication(
    options: IOpenAiAuthOptions = {},
): IAuthenticationComposition {
    const openAi = new OpenAiAuth(options)
    return {
        openAi,
        service: new AuthenticationService([openAi]),
    }
}
