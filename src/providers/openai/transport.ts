import { createOpenAI, type OpenAIProviderSettings } from "@ai-sdk/openai"
import { streamText } from "ai"

import {
  OPENAI_CODEX_API_BASE_URL,
  OPENAI_CODEX_CLIENT_VERSION,
} from "@/providers/openai/constants"

/// bedziemy mieli 3 sytuacje
//
// jezeli chcemy rozwiazac kazdy problem fajnie bylo by znac wszystkie mozliwosci
// przeanalizowac tradeoffy i zrozumiec konsekwencje kazdej z tych decyzji
//
// planowanie
// glownie skupiamy sie na pair programmingu analizie co 3ba zrobic jak to zrobic i jakie nasze zmiany beda mialy konsekwencje
// wieksze plany tez moga byc ale wszystko musi sie opierac o burze mozgow
//
//
// implementowanie
// glownie skupiamy sie na malych targetowanych zmianach chyba, ze uzgodnimy inaczej
//
// i modyfikacje tylko na wyrazna prosbe uzytkownika
//
//
// nauke
// pod nauke stworzymy mcp serwer do tworzenia i zarzadzania notatkami, wyswietlanie web


export const systemPrompt = (): string => {
  return [
    "Jesteś pair programming / mentorem / nauczycielem programowania.",
    "Pomagasz i uczysz pisać doskonały producyjny kod bez bugów.",
    "Jesteś nastawiony na naukę więc tłumaczysz dokładnie wszystko początkującemu programiście używając bardzo prostego języka.",
    "Tłumaczysz wszystko co robisz, każda komendę którą wywołasz kod który zmienisz etc.",
    "Nie zmieniasz niczego bez pozwolenia.",
    "Jeżeli pytanie użytkownika dotyczy kodu, zewnętrznej biblioteki lub czekogolwiek innego,",
    "zawsze upewnij się na 100%, że znalazłeś wszystkie potrzebne informację,",
    "żeby wytłumaczyć wszystko bardzo dokładnie czytając kod źródłowy bibliotek, frameworków, narzędzi lub szukajać informacji w dokumentacji lub informacji w internecie.",
    "Zawsze podawaj źródła swoich informacji.",
    "Tłumacz zwięźle używając tylko słów potrzebnych, żeby dać merytoryczną wartość użytkownikowi.",
    "Jeżeli tłumaczysz zewnętrzną bibliotekę lub narzędzie zawsze tłumacz je kompleksowo i bądź w tym dokładny, nie pomijaj niczego a podawaj wszystkie przykłady zastosowań, żeby rozwiać wszelkie wątpliwości jak ich używać.",

    "Zawsze wyjaśniaj konsekwencje zmian, które wprowadzamy",
  ].join("\n")
}

type OpenAiOAuthCredentials = {
  accessToken: string
  accountId?: string | undefined
}

export const streamOpenAiTextWithAuth = (
  prompt: string,
  auth: OpenAiOAuthCredentials,
  fetch?: OpenAIProviderSettings["fetch"],
) => {
  const headers: Record<string, string> = {
    version: OPENAI_CODEX_CLIENT_VERSION,
    originator: "buli",
  }

  if (auth.accountId) {
    headers["ChatGPT-Account-ID"] = auth.accountId
  }

  const openai = createOpenAI({
    apiKey: auth.accessToken,
    baseURL: OPENAI_CODEX_API_BASE_URL,
    headers,
    ...(fetch ? { fetch } : {}),
  })

  return streamText({
    model: openai.responses("gpt-5.6-sol"),
    system: systemPrompt(),
    prompt,
    providerOptions: {
      openai: {
        store: false,
      },
    },
  })
}












