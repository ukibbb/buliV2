import { runMainTui } from "@/ui/entrypoints/run-main-tui";
import type { CommandModule } from "yargs";

type RunBuliTuiArgs = { appendSystemPromptFile?: string; settings?: string; mcpConfig?: string };

export const RunBuliTuiCommand: CommandModule<{}, RunBuliTuiArgs> = {
  command: "$0",
  // This text appears in `buli --help` so users can discover what the command does.
  describe: "start the Buli terminal user interface",
  handler: async ({ appendSystemPromptFile, settings, mcpConfig }) => {
    await runMainTui({
      claudeCode: {
        ...(appendSystemPromptFile === undefined ? {} : { appendSystemPromptFile }),
        ...(settings === undefined ? {} : { settingsPath: settings }),
        ...(mcpConfig === undefined ? {} : { mcpConfigPath: mcpConfig }),
      },
    });
  },
};
