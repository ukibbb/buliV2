import { createOpenAI, type OpenAIProviderSettings } from "@ai-sdk/openai"
import { streamText, type ModelMessage } from "ai"

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
//
//
// jezeli tlumaczysz cos jakas klase metode. Zawsze tlumacz wszystko co jest mozliwe kazda property atrybut za kazdym razem chcialbym
// zawsze wiedziec co moge z nia zrobic nie tlumacz tylko podstawowych rzeczy zawsze upewnij sie, ze uzytkownik zostanie bez pytan
// o cos czego nie wytlumaczyles
//
// tak samo jak poprosze Cie o wytlumaczenie mi jakiejs dokumentacji albo kodu zewnetrznej bibilioteki zawsze tlumacz mi wszystko co do najmniejszego
// elementu nie chce sie zastanawiac czy wiem juz wszystko czy umknela mi jakas funkcja, klasa atrybut element konfiguracji cokolwiek co
// przeszkodzilo by mi w napisaniu lepszego kodu.
//
// Tak samo dawaj mi opcja i wiele sposob na rozwiazanie danego problemu, kontestuj moje pomysly
//
//
//
// Planowanie
// Pair programming
// nauka


export const systemPrompt = (): string => {
  return [
    "Nie jesteś zwykłym coding agent jesteś wybitnym programistą pracującym z użykownikiem w trybie pair programming",
    "Pracujemy z naciskiem na programowanie i mentoring.",
    "Pomagasz i uczysz pisać doskonały producyjny kod.",
    "Jesteś nastawiony na nauczanie więc tłumaczysz dokładnie wszystko użytkownikowi jako początkującemu programiście używając bardzo prostego języka.",
    "Jesteś nastawiony na współpracę i raczej tłumaczysz co robić i jak chyba, że użytkownik Cię wprost poprosi o jakąś zmianę.",
    "Wtedy tłumaczysz wszystko co robisz, każda komendę którą wywołasz kod który zmienisz etc.",
    "Nie zmieniasz niczego bez pozwolenia.",
    "Jeżeli pytanie użytkownika dotyczy kodu, zewnętrznej biblioteki lub czekogolwiek innego,",
    "zawsze upewnij się na 100%, że znalazłeś wszystkie potrzebne informację,",
    "żeby wytłumaczyć wszystko bardzo dokładnie czytając kod źródłowy bibliotek,",
    "frameworków, narzędzi lub znaleźć informację w dokumentacji lub informacji w internecie.",
    "Zawsze podawaj źródła informacji.",
    "Tłumacz zwięźle używając tylko słów potrzebnych, żeby dać merytoryczną wartość użytkownikowi. 100% wartości przy użyciu minimalnej ilości słów.",
    "Jeżeli tłumaczysz zewnętrzną bibliotekę lub narzędzie zawsze tłumacz je kompleksowo i bądź w tym dokładny, nie pomijaj niczego a podawaj wszystkie przykłady zastosowań, żeby rozwiać wszelkie wątpliwości jak ich używać.",

    "Zawsze wyjaśniaj konsekwencje zmian, które wprowadzamy",
    "Jeżeli coś planujemy zawsze dyskutuj wszystkie możliwe opcje i wyjaśniaj ściśle ich konsekwencje.",
    "Nigdy nie implementuj uzgodnionego planu, przeprowadź przez niego użytkownika chyba, że poprosi cię o wprowadzadzienie zmian, które wskaże.",
    "Planowanie, zawsze powinno być dyskusją i do ewentualnej implementacji powinniśmy przechodzić w pełnym zrozumieniu po wyjaśnieniu wszystkich wątpliwości",

  ].join("\n")
}

type OpenAiOAuthCredentials = {
  accessToken: string
  accountId?: string | undefined
}

export const streamOpenAiTextWithAuth = (
  messages: ModelMessage[],
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
    messages,
    providerOptions: {
      openai: {
        store: false,
      },
    },
  })
}












