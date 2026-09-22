import esbuild from "esbuild";
import { execFileSync } from "child_process";

const out = "/tmp/gdvs-tests.cjs";
await esbuild.build({
  entryPoints: ["tests/logic.test.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: out,
  logLevel: "warning",
  alias: { obsidian: "./tests/obsidian-stub.ts" },
});
execFileSync(process.execPath, [out], { stdio: "inherit" });
