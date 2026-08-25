import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import npmPackageMetadata from "../npm/package.json" with { type: "json" };
import packageMetadata from "../package.json" with { type: "json" };
import { installBinary } from "../npm/install.mjs";

test("npm package metadata matches the release and exposes the launcher", () => {
  expect(npmPackageMetadata.name).toBe("@ukibbb/buli");
  expect(npmPackageMetadata.version).toBe(packageMetadata.version);
  expect(npmPackageMetadata.bin).toEqual({ buli: "bin/buli.mjs" });
  expect(npmPackageMetadata.publishConfig).toEqual({ access: "public" });
});

test.skipIf(process.platform === "win32")(
  "npm installer downloads the exact package version and verifies its checksum",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "buli-npm-test-"));
    try {
      const bundle = join(root, "bundle", "buli-linux-x64");
      await mkdir(join(bundle, "bin"), { recursive: true });
      await mkdir(join(bundle, "lib", "buli"), { recursive: true });
      await executable(
        join(bundle, "bin", "buli"),
        `#!/bin/sh\nprintf '${packageMetadata.version}\\n'\n`,
      );
      await executable(join(bundle, "lib", "buli", "rg"), "#!/bin/sh\nprintf 'fixture rg\\n'\n");
      await executable(join(bundle, "lib", "buli", "fd"), "#!/bin/sh\nprintf 'fixture fd\\n'\n");
      await writeFile(join(bundle, "THIRD_PARTY_LICENSES"), "fixture licenses\n");
      const archivePath = join(root, "buli-linux-x64.tar.gz");
      const tar = Bun.spawn([
        "tar", "--create", "--gzip", "--file", archivePath,
        "--directory", join(root, "bundle"), "buli-linux-x64",
      ]);
      expect(await tar.exited).toBe(0);
      const archive = await readFile(archivePath);
      const checksum = createHash("sha256").update(archive).digest("hex");
      const urls: string[] = [];
      await installBinary({
        version: packageMetadata.version,
        platform: "linux",
        architecture: "x64",
        destination: join(root, "vendor"),
        fetchAsset: async (input: string | URL | Request) => {
          urls.push(String(input));
          return String(input).endsWith(".sha256")
            ? new Response(`${checksum}  buli-linux-x64.tar.gz\n`)
            : new Response(archive);
        },
      });
      expect(urls).toContain(
        `https://github.com/ukibbb/buliV2/releases/download/v${packageMetadata.version}/buli-linux-x64.tar.gz`,
      );
      expect(await readFile(join(root, "vendor", "bin", "buli"), "utf8"))
        .toContain(packageMetadata.version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
