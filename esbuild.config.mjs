import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// Node builtins are marked external so the bundle never inlines them.
// `http` is only ever `require`d inside a Platform.isDesktopApp branch,
// so the module is never touched on iOS.
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
  platform: "browser",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
