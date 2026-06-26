import { Command, register } from "./index.mjs";

const CDN_URL = "https://unpkg.com/esbuild-wasm@0.27.2/esm/browser.min.js";
const WASM_URL = "https://unpkg.com/esbuild-wasm@0.27.2/esbuild.wasm";

let esbuildModule = null;
let esbuildReady = null;

async function getEsbuild() {
  if (esbuildModule) return esbuildModule;
  if (esbuildReady) return esbuildReady;

  esbuildReady = (async () => {
    const mod = await import(CDN_URL);
    await mod.initialize({
      worker: true,
      wasmURL: WASM_URL,
    });
    esbuildModule = mod;
    return mod;
  })();

  return esbuildReady;
}

function createFsPlugin(fs) {
  return {
    name: "virtual-fs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: "virtual-fs" };
        }
        if (args.kind === "import-statement" || args.kind === "require-call") {
          const base = args.resolveDir || "/";
          const resolved = resolveRelative(args.path, base);
          return { path: resolved, namespace: "virtual-fs" };
        }
        return { external: true };
      });

      build.onLoad({ filter: /.*/, namespace: "virtual-fs" }, async (args) => {
        try {
          const content = await fs.readFile(args.path, { encoding: "utf8" });
          const ext = args.path.split(".").pop();
          const loaderMap = {
            js: "js",
            mjs: "js",
            ts: "ts",
            tsx: "tsx",
            jsx: "jsx",
            css: "css",
            json: "json",
            html: "text",
          };
          return {
            contents: content,
            loader: loaderMap[ext] || "text",
          };
        } catch (e) {
          return { errors: [{ text: e.message }] };
        }
      });
    },
  };
}

function resolveRelative(path, base) {
  if (path.startsWith("/")) return path;
  const baseParts = base.replace(/^\//, "").split("/").filter(Boolean);
  baseParts.pop();
  const parts = path.split("/").filter(Boolean);
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") baseParts.pop();
    else baseParts.push(part);
  }
  return "/" + baseParts.join("/");
}

class EsbuildCommand extends Command {
  constructor() {
    super("esbuild", "Bundle JavaScript/TypeScript with esbuild", ["build"]);
  }

  async execute(args, { terminal, fs }) {
    const entry = args[1];
    const out = args[2] || "dist/bundle.js";
    if (!entry) {
      throw new Error("Usage: esbuild <entry> [outfile] [--minify] [--format=esm|iife|cjs]");
    }

    const mod = await getEsbuild();
    const options = {
      entryPoints: [entry],
      bundle: true,
      write: false,
      plugins: [createFsPlugin(fs)],
    };

    for (let i = 3; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--minify") options.minify = true;
      else if (arg === "--sourcemap") options.sourcemap = true;
      else if (arg.startsWith("--format=")) options.format = arg.slice(9);
      else if (arg.startsWith("--target=")) options.target = arg.slice(9);
      else if (arg === "--watch") options.watch = true;
    }

    try {
      const result = await mod.build(options);

      if (result.errors.length > 0) {
        const lines = result.errors.map((e) => `  error: ${e.text}`);
        return { class: "log-error", content: lines.join("\n") };
      }

      if (result.warnings.length > 0) {
        for (const w of result.warnings) {
          terminal.log(`  warning: ${w.text}`, { class: "log-warn" });
        }
      }

      if (result.outputFiles && result.outputFiles.length > 0) {
        const outFile = result.outputFiles[0];
        const code = outFile.text;
        const parentDir = out.split("/").slice(0, -1).join("/");
        if (parentDir) {
          await fs.mkdir(parentDir, { recursive: true });
        }
        await fs.writeFile(out, code);
        return `Built ${entry} -> ${out} (${code.length} bytes)`;
      }

      return "Build completed with no output.";
    } catch (err) {
      return { class: "log-error", content: err.message };
    }
  }
}

register(new EsbuildCommand());
