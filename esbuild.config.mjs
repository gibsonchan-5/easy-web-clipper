import esbuild from "esbuild";
import { builtinModules } from "module";
import process from "process";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

const plugin = {
  name: "obsidian-esbuild-plugin",
  setup(build) {
    // 处理 node 内置模块 - 标记为外部依赖或提供空模块
    build.onResolve({ filter: /^(fs|path|os|crypto|stream|util|events|http|https|net|tls|url|zlib|child_process|worker_threads|perf_hooks)$/ }, (args) => {
      return { path: args.path, external: true };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  plugins: [plugin],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  define: {
    "process.env.NODE_ENV": prod ? '"production"' : '"development"',
  },
});

if (prod) {
  await context.rebuild();
  // 复制 manifest.json 到项目根目录（如果不存在）
  if (!fs.existsSync("manifest.json")) {
    console.warn("manifest.json not found!");
  }
  process.exit(0);
} else {
  await context.watch();
}
