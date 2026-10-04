import esbuild from "esbuild";
import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Every tests/*.test.ts file is bundled and run in its own process. Each run
// gets a private temp directory, so two test runs at once never overwrite
// each other's bundles.
const files = readdirSync("tests")
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
const dir = mkdtempSync(join(tmpdir(), "gdvs-tests-"));
const failed = [];

try {
  for (const file of files) {
    const out = join(dir, file.replace(/\.ts$/, ".cjs"));
    await esbuild.build({
      entryPoints: [join("tests", file)],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: out,
      logLevel: "warning",
      alias: { obsidian: "./tests/obsidian-stub.ts" },
    });
    console.log(`\n── ${file}`);
    try {
      execFileSync(process.execPath, [out], { stdio: "inherit" });
    } catch {
      failed.push(file);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failed.length
    ? `\n${failed.length} of ${files.length} test files failed: ${failed.join(", ")}`
    : `\nAll ${files.length} test files passed`,
);
if (failed.length) process.exit(1);
