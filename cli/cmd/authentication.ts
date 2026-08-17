import type { CommandModule } from "yargs";

import { authenticationMain } from "@/authentication-main";

type AuthenticationCommandArgs = {};

export const LoginCommand: CommandModule<{}, AuthenticationCommandArgs> = {
  command: "login",
  describe: "connect an authentication provider",
  handler: async () => {
    setExitCode(await authenticationMain("login"));
  },
};

export const LogoutCommand: CommandModule<{}, AuthenticationCommandArgs> = {
  command: "logout",
  describe: "disconnect an authentication provider",
  handler: async () => {
    setExitCode(await authenticationMain("logout"));
  },
};

function setExitCode(outcome: Awaited<ReturnType<typeof authenticationMain>>): void {
  if (outcome === "failure") process.exitCode = 1;
  if (outcome === "cancelled") process.exitCode = 130;
}
