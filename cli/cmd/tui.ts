import { runBuliTui } from "@/tui";
import type { ArgumentsCamelCase, CommandModule } from "yargs";

type RunBuliTuiArgs = {};

export const RunBuliTuiCommand: CommandModule<{}, RunBuliTuiArgs> = {
  command: "$0",
  // This text appears in `buli --help` so users can discover what the command does.
  describe: "start the Buli terminal user interface",
  handler: async (argv: ArgumentsCamelCase<RunBuliTuiArgs>) => {
    await runBuliTui();
  },
};
