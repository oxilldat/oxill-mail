import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const isProd = process.argv[2] === "production";
const root = dirname(fileURLToPath(import.meta.url));
const context = await esbuild.context({
  entryPoints: [join(root, "src", "main.ts")],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  format: "cjs",
  target: "es2022",
  charset: "utf8",
  sourcemap: isProd ? false : "inline",
  minify: isProd,
  outfile: join(root, "main.js")
});

if (isProd) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Oxill Mail: watch mode");
}
