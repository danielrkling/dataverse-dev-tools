import { dirname, join } from "../utils/path.mjs";
import { tailwindConfigSchema } from "../utils/schemas.mjs";
import { createCommand } from "../terminal.mjs";
import {
  object,
  optional,
  argument,
  choice,
  message,
  option,
  string,
  multiple,
  map,
} from "@optique/core";
import {
  aliasPlugin,
  fsPlugin,
  getEsbuild,
  httpPlugin,
} from "../utils/esbuild.mjs";
import picomatch from "picomatch";

const TAILWIND_VERSION = "4.1.6";
const COMPILE_URL = `https://esm.sh/tailwindcss@${TAILWIND_VERSION}`;
const ISO_URL =
  "https://cdn.jsdelivr.net/npm/tailwindcss-iso@1.0.6/dist/browser.js";
const CSS_BASE = `https://cdn.jsdelivr.net/npm/tailwindcss@${TAILWIND_VERSION}`;

/** @type {Map<string, string>} */
const cssCache = new Map();

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function getCSSAsset(name) {
  if (cssCache.has(name)) return /** @type {string} */ (cssCache.get(name));
  const url = `${CSS_BASE}/${name}.css`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch tailwindcss asset: ${name}`);
  const text = await res.text();
  cssCache.set(name, text);
  return text;
}

/** @type {((css: string, opts: any) => any) | null} */
let _compile = null;

/** @returns {Promise<((css: string, opts: any) => any)>} */
async function getCompile() {
  if (!_compile) {
    const mod = await import(COMPILE_URL);
    _compile = mod.compile;
  }
  return /** @type {((css: string, opts: any) => any)} */ (_compile);
}

/** @type {((opts: { content: string, extension: string }) => string[]) | null} */
let _getTailwindClasses = null;

/** @returns {Promise<void>} */
async function ensureWasmLoaded() {
  if (!_getTailwindClasses) {
    const mod = await import(ISO_URL);
    _getTailwindClasses = mod.getTailwindClasses;
  }
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {(id: string, base: string) => Promise<{path: string, base: string, content: string}>}
 */
function createLoadStylesheet(fs) {
  return async (id, base) => {
    const name = id.replace(/\.css$/, "");
    if (name === "tailwindcss") {
      return {
        path: "virtual:tailwindcss/index.css",
        base: "/",
        content: await getCSSAsset("index"),
      };
    }
    if (name === "tailwindcss/preflight" || name === "./preflight") {
      return {
        path: "virtual:tailwindcss/preflight.css",
        base: "/",
        content: await getCSSAsset("preflight"),
      };
    }
    if (name === "tailwindcss/theme" || name === "./theme") {
      return {
        path: "virtual:tailwindcss/theme.css",
        base: "/",
        content: await getCSSAsset("theme"),
      };
    }
    if (name === "tailwindcss/utilities" || name === "./utilities") {
      return {
        path: "virtual:tailwindcss/utilities.css",
        base: "/",
        content: "@tailwind utilities;",
      };
    }

    if (id.startsWith("http://") || id.startsWith("https://")) {
      const res = await fetch(id);
      return { path: id, base, content: await res.text() };
    }

    const fullPath = base && base !== "/" ? join(base, id) : id;
    const content = await fs.readFile(fullPath, { encoding: "utf8" });
    return { path: fullPath, base: dirname(fullPath) || "/", content };
  };
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {(id: string, base: string) => Promise<{path: string, base: string, module: any}>}
 */
function createLoadModule(fs) {
  return async (id, base) => {
    if (id.startsWith("http://") || id.startsWith("https://")) {
      const mod = await import(id);
      return { path: id, base, module: mod.default || mod };
    }

    if (!id.startsWith("./") && !id.startsWith("../") && !id.startsWith("/")) {
      const mod = await import(`https://esm.sh/${id}`);
      return { path: id, base, module: mod.default || mod };
    }

    const fullPath = base && base !== "/" ? join(base, id) : id;
    const esbuild = await getEsbuild();
    const result = await esbuild.build({
      entryPoints: [fullPath],
      bundle: true,
      format: "esm",
      write: false,
      plugins: [aliasPlugin(), httpPlugin(), fsPlugin(fs)],
    });
    const blob = new Blob([result.outputFiles[0].text], {
      type: "application/javascript",
    });
    const url = URL.createObjectURL(blob);
    try {
      const mod = await import(url);
      return {
        path: fullPath,
        base: dirname(fullPath) || "/",
        module: mod.default || mod,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  };
}

/**
 * @param {object} config
 * @param {string | string[]} [config.css]
 * @param {string} [config.importCSS]
 * @param {string[]} [config.plugins]
 * @returns {string}
 */
function buildCSSInput(config) {
  if (Array.isArray(config.css)) {
    return config.css
      .map((item) => {
        const t = item.trim();
        if (
          t.startsWith("@") ||
          t.startsWith("http://") ||
          t.startsWith("https://")
        )
          return t;
        return `@import "${t}"`;
      })
      .join("\n");
  }
  const parts = [];
  if (config.importCSS) parts.push(config.importCSS);
  else parts.push('@import "tailwindcss"');
  if (config.css && typeof config.css === "string")
    parts.push(`@import "${config.css}"`);
  if (config.plugins) {
    for (const p of config.plugins) {
      if (
        p.startsWith("http://") ||
        p.startsWith("https://") ||
        p.startsWith("./") ||
        p.startsWith("/")
      ) {
        parts.push(`@import "${p}"`);
      } else {
        parts.push(`@plugin "${p}"`);
      }
    }
  }
  return parts.join("\n");
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string[]} globs
 * @returns {Promise<string[]>}
 */
async function extractClasses(fs, globs) {
  await ensureWasmLoaded();
  const classes = new Set();
  const isMatch = picomatch(globs.map((g) => g.replace(/^\.\//, "")));

  const files = await fs.getFilesFromDirectory("", isMatch);

  /** @type {Record<string, string[]>} */
  const byExt = {};
  for (const [filePath, content] of files) {
    const dot = filePath.lastIndexOf(".");
    if (dot === -1) continue;
    const ext = filePath.slice(dot + 1);
    (byExt[ext] ||= []).push(content);
  }

  for (const [ext, contents] of Object.entries(byExt)) {
    const results = await /** @type {Function} */ (_getTailwindClasses)({
      content: contents.join("\n"),
      extension: ext,
    });
    for (const r of results) {
      classes.add(r);
    }
  }

  return [...classes];
}

/**
 * @param {{ content?: string[], css?: string | string[], importCSS?: string, outfile?: string, plugins?: string[] }} config
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {{ getOrCreateCompiler(): Promise<any>, invalidateCache(): void }}
 */
function createCompilerCache(config, fs) {
  /** @type {any} */
  let compiler = null;
  /** @type {string | null} */
  let lastCSSInput = null;
  return {
    async getOrCreateCompiler() {
      const cssInput = buildCSSInput(config);
      if (compiler && cssInput === lastCSSInput) return compiler;
      const compile = await getCompile();
      const ls = createLoadStylesheet(fs);
      const lm = createLoadModule(fs);
      compiler = await /** @type {Function} */ (compile)(cssInput, {
        base: "/",
        loadStylesheet: ls,
        loadModule: lm,
      });
      lastCSSInput = cssInput;
      return compiler;
    },
    invalidateCache() {
      lastCSSInput = null;
    },
  };
}

/**
 * @param {{ content?: string[], css?: string | string[], importCSS?: string, outfile?: string, plugins?: string[] }} config
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {import('../terminal.mjs').WebTerminal} term
 * @returns {Promise<{outfile: string, bytes: number, classes: number}>}
 */
async function runBuild(config, fs, term) {
  const cache = createCompilerCache(config, fs);
  const c = await cache.getOrCreateCompiler();
  const globs = config.content || ["./src/**/*.{html,js,ts,jsx,tsx,mjs}"];
  const classes = await extractClasses(fs, globs);
  const result = await c.build(classes);
  const outfile = config.outfile || "./dist/tailwind.css";
  const dir = dirname(outfile);
  if (dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {}
  }
  await fs.writeFile(outfile, result);
  return { outfile, bytes: result.length, classes: classes.length };
}

const tailwindParser = object({
  action: optional(
    argument(choice(["build", "watch"]), {
      description: message`Tailwind action (build or watch)`,
    }),
  ),
  config: optional(
    option("-c", "--config", string({ metavar: "FILE" }), {
      description: message`Path to config file (default: tailwind.config.json)`,
    }),
  ),
  css: map(
    optional(
      option("-i", "--input", string({ metavar: "FILE" }), {
        description: message`Input CSS file`,
      }),
    ),
    (s) => (s ? [s] : undefined),
  ),
  outfile: optional(
    option("-o", "--output", string({ metavar: "FILE" }), {
      description: message`Output CSS file`,
    }),
  ),
  watch: optional(
    option("--watch", {
      description: message`Watch for changes and rebuild`,
    }),
  ),
  content: multiple(
    option("--content", string({ metavar: "GLOB" }), {
      description: message`Glob pattern for content files to scan`,
    }),
  ),
});

export default createCommand({
  name: "tailwind",
  parser: tailwindParser,
  aliases: ["tw"],
  description: message`Generate Tailwind CSS using compile() API with WasmScanner`,
  usage: message`tailwind [build|watch] [-i FILE] [-o FILE] [--watch] [--content GLOB]...`,
  brief: message`Generate Tailwind CSS using compile() API with WasmScanner`,
  execute: async (parsed, term) => {
    const configPath = parsed.config || "tailwind.config.json";

    let rawConfig;
    try {
      const content = await term.fs.readFile(configPath, { encoding: "utf8" });
      rawConfig = JSON.parse(content);
    } catch (e) {
      if (parsed.config) {
        term.error(`${configPath}: ${e.message}`);
        return;
      }
      rawConfig = {};
    }

    const configResult = tailwindConfigSchema.safeParse(rawConfig);
    if (!configResult.success) {
      term.error(
        `${configPath}: ${configResult.error.issues.map((i) => i.message).join(", ")}`,
      );
      return;
    }
    const validatedConfig = configResult.data;

    const { config: _, ...cliFields } = parsed;
    const mergedResult = tailwindConfigSchema.safeParse({
      ...validatedConfig,
      ...cliFields,
    });
    if (!mergedResult.success) {
      term.error(
        `Config merge: ${mergedResult.error.issues.map((i) => i.message).join(", ")}`,
      );
      return;
    }
    const config = mergedResult.data;

    const sub = parsed.watch
      ? "watch"
      : /** @type {string} */ (parsed.action || "build");

    if (sub === "watch") {
      const { outfile, bytes, classes } = await runBuild(config, term.fs, term);
      term.success(`Built ${outfile} (${bytes} bytes, ${classes} classes)`);

      const isMatch = picomatch(
        config.content.map((/** @type {string} */ g) => g.replace(/^\.\//, "")),
      );
      const handler = async (/** @type {CustomEvent} */ e) => {
        const path = e.detail?.path;
        if (!path) return;
        if (!isMatch(path)) return;
        try {
          const { outfile, bytes, classes } = await runBuild(
            config,
            term.fs,
            term,
          );
          term.info(`Rebuilt ${outfile} (${bytes} bytes, ${classes} classes)`);
        } catch (/** @type {any} */ e) {
          term.error(`Rebuild failed: ${e.message}`);
        }
      };

      term.addEventListener("fs:modified", handler);
      const stopBtn = document.createElement("button");
      stopBtn.textContent = "⏹ stop watching";
      stopBtn.addEventListener("click", () => {
        term.removeEventListener("fs:modified", handler);
        stopBtn.remove();
      });
      term.log(stopBtn);

      term.info("Watching for changes...");
      return undefined;
    } else {
      const { outfile, bytes, classes } = await runBuild(config, term.fs, term);
      term.success(`Wrote ${outfile} (${bytes} bytes, ${classes} classes)`);
      return undefined;
    }
  },
});
