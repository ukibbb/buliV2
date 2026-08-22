import type { CommandModule } from "yargs";

import { runAuthenticationTui } from "@/app/entrypoints/run-authentication-tui";

type AuthenticationCommandArgs = {};

export const LoginCommand: CommandModule<{}, AuthenticationCommandArgs> = {
  command: "login",
  describe: "connect an authentication provider",
  handler: async () => {
    setExitCode(await runAuthenticationTui("login"));
  },
};

export const LogoutCommand: CommandModule<{}, AuthenticationCommandArgs> = {
  command: "logout",
  describe: "disconnect an authentication provider",
  handler: async () => {
    setExitCode(await runAuthenticationTui("logout"));
  },
};

function setExitCode(outcome: Awaited<ReturnType<typeof runAuthenticationTui>>): void {
  if (outcome === "failure") process.exitCode = 1;
  if (outcome === "cancelled") process.exitCode = 130;
}
