import { esbuildConfigSchema } from "../utils/schemas.mjs";
import {
  object,
  optional,
  option,
  argument,
  string,
  message,
  multiple,
  map,
  choice,
  integer,
  or,
  flag,
} from "@optique/core";
import { createCommand } from "../terminal.mjs";
import {
  aliasPlugin,
  fsPlugin,
  getEsbuild,
  httpPlugin,
} from "../utils/esbuild.mjs";
import picomatch from "picomatch";

/**
 * Convert esbuild-style --flag:value args to --flag value for optique parsing.
 * @param {string[]} args
 * @returns {string[]}
 */
function preprocessArgs(args) {
  const result = [];
  for (const arg of args) {
    const m = arg.match(/^(--[\w-]+):(.+)/);
    if (m) {
      result.push(m[1], m[2]);
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * Split a "key=value" string on the first `=`.
 * @param {string} s
 * @returns {[string, string]}
 */
function splitEq(s) {
  const i = s.indexOf("=");
  return [s.slice(0, i), s.slice(i + 1)];
}

// --- CLI PARSER ---

const esbuildParser = object({
  entryPoints: multiple(
    argument(string({ metavar: "FILES" }), {
      description: message`Entry point files or glob patterns`,
    }),
  ),

  // General
  config: optional(
    option("-c", "--config", string({ metavar: "FILE" }), {
      description: message`Path to config file (default: esbuild.config.json)`,
    }),
  ),
  bundle: optional(
    option("--bundle", {
      description: message`Bundle all dependencies into the output files`,
    }),
  ),
  platform: optional(
    option(
      "--platform",
      choice(["browser", "node", "neutral"], { metavar: "PLATFORM" }),
      {
        description: message`Platform target (browser, node, neutral)`,
      },
    ),
  ),
  tsconfig: optional(
    option("--tsconfig", string({ metavar: "FILE" }), {
      description: message`Use the tsconfig.json from this file instead of the default`,
    }),
  ),
  watch: optional(
    option("--watch", { description: message`Watch for changes and rebuild` }),
  ),

  // Input
  loader: map(
    multiple(option("--loader", string({ metavar: "EXT=NAME" }))),
    (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
  ),

  // Output contents
  format: optional(
    option("--format", choice(["iife", "cjs", "esm"], { metavar: "FORMAT" }), {
      description: message`Output format (iife, cjs, esm)`,
    }),
  ),
  splitting: optional(
    option("--splitting", { description: message`Enable code splitting` }),
  ),
  banner: map(
    multiple(option("--banner", string({ metavar: "TYPE=TEXT" }))),
    (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
  ),
  footer: map(
    multiple(option("--footer", string({ metavar: "TYPE=TEXT" }))),
    (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
  ),
  charset: optional(
    option("--charset", choice(["utf8", "ascii"], { metavar: "CHARSET" }), {
      description: message`Character set (utf8, ascii)`,
    }),
  ),
  globalName: optional(
    option("--global-name", string({ metavar: "NAME" }), {
      description: message`Global name for the IIFE format`,
    }),
  ),
  legalComments: optional(
    option(
      "--legal-comments",
      choice(["none", "inline", "eof", "linked", "external"], {
        metavar: "MODE",
      }),
      {
        description: message`How to handle legal comments`,
      },
    ),
  ),
  lineLimit: optional(
    option("--line-limit", integer({ metavar: "N" }), {
      description: message`Line length limit`,
    }),
  ),

  // Output location
  outdir: optional(
    option("--outdir", string({ metavar: "DIR" }), {
      description: message`Output directory`,
    }),
  ),
  outfile: optional(
    option("--outfile", string({ metavar: "FILE" }), {
      description: message`Output file (mutually exclusive with outdir)`,
    }),
  ),
  outbase: optional(
    option("--outbase", string({ metavar: "DIR" }), {
      description: message`Base directory for output paths`,
    }),
  ),
  outExtension: map(
    multiple(option("--out-extension", string({ metavar: "EXT=EXT" }))),
    (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
  ),
  entryNames: optional(
    option("--entry-names", string({ metavar: "PATTERN" }), {
      description: message`Pattern for entry point output file names`,
    }),
  ),
  chunkNames: optional(
    option("--chunk-names", string({ metavar: "PATTERN" }), {
      description: message`Pattern for chunk output file names`,
    }),
  ),
  assetNames: optional(
    option("--asset-names", string({ metavar: "PATTERN" }), {
      description: message`Pattern for asset output file names`,
    }),
  ),
  publicPath: optional(
    option("--public-path", string({ metavar: "PATH" }), {
      description: message`Public path for assets`,
    }),
  ),
  allowOverwrite: optional(
    option("--allow-overwrite", {
      description: message`Allow output files to overwrite input files`,
    }),
  ),

  // Path resolution
  alias: map(
    multiple(option("--alias", string({ metavar: "FROM=TO" }))),
    (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
  ),
  conditions: map(
    multiple(option("--conditions", string({ metavar: "COND" }))),
    (arr) => [...arr],
  ),
  external: map(
    multiple(option("--external", string({ metavar: "NAME" }))),
    (arr) => [...arr],
  ),
  mainFields: map(
    optional(
      option("--main-fields", string({ metavar: "FIELDS" }), {
        description: message`Main fields to use (comma-separated)`,
      }),
    ),
    (s) => (s ? s.split(",").map((x) => x.trim()) : undefined),
  ),
  nodePaths: map(
    optional(
      option("--node-paths", string({ metavar: "PATHS" }), {
        description: message`Node paths for module resolution (comma-separated)`,
      }),
    ),
    (s) => (s ? s.split(",").map((x) => x.trim()) : undefined),
  ),
  preserveSymlinks: optional(
    option("--preserve-symlinks", { description: message`Preserve symlinks` }),
  ),
  resolveExtensions: map(
    optional(
      option("--resolve-extensions", string({ metavar: "EXTS" }), {
        description: message`Resolve extensions (comma-separated)`,
      }),
    ),
    (s) => (s ? s.split(",").map((x) => x.trim()) : undefined),
  ),
  packages: optional(
    option("--packages", choice(["external"], { metavar: "MODE" }), {
      description: message`Packages mode (external)`,
    }),
  ),
  absWorkingDir: optional(
    option("--abs-working-dir", string({ metavar: "DIR" }), {
      description: message`Absolute working directory`,
    }),
  ),

  // Transformation
  jsx: optional(
    option(
      "--jsx",
      choice(["transform", "preserve", "automatic"], { metavar: "MODE" }),
      {
        description: message`JSX mode (transform, preserve, automatic)`,
      },
    ),
  ),
  jsxDev: optional(option("--jsx-dev", { description: message`JSX dev mode` })),
  jsxFactory: optional(
    option("--jsx-factory", string({ metavar: "FACTORY" }), {
      description: message`JSX factory function`,
    }),
  ),
  jsxFragment: optional(
    option("--jsx-fragment", string({ metavar: "FRAGMENT" }), {
      description: message`JSX fragment function`,
    }),
  ),
  jsxImportSource: optional(
    option("--jsx-import-source", string({ metavar: "SOURCE" }), {
      description: message`JSX import source`,
    }),
  ),
  jsxSideEffects: optional(
    option("--jsx-side-effects", { description: message`JSX side effects` }),
  ),
  supported: map(
    multiple(option("--supported", string({ metavar: "FEATURE=BOOL" }))),
    (arr) => {
      const obj = /** @type {Record<string, boolean>} */ ({});
      for (const s of arr) {
        const [k, v] = splitEq(s);
        obj[k] =
          v === "true" ? true : v === "false" ? false : /** @type {any} */ (v);
      }
      return obj;
    },
  ),
  target: optional(
    option("--target", string({ metavar: "TARGET" }), {
      description: message`Language target (es2020, esnext, etc.)`,
    }),
  ),

  // Optimization
  define: map(
    multiple(option("--define", string({ metavar: "KEY=VALUE" }))),
    (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
  ),
  drop: map(
    multiple(
      option("--drop", choice(["console", "debugger"], { metavar: "WHAT" })),
    ),
    (arr) => [...arr],
  ),
  dropLabels: map(
    multiple(option("--drop-labels", string({ metavar: "LABEL" }))),
    (arr) => [...arr],
  ),
  ignoreAnnotations: optional(
    option("--ignore-annotations", {
      description: message`Ignore side-effect annotations`,
    }),
  ),
  inject: map(
    multiple(option("--inject", string({ metavar: "FILE" }))),
    (arr) => [...arr],
  ),
  keepNames: optional(
    option("--keep-names", { description: message`Keep original names` }),
  ),
  mangleProps: optional(
    option("--mangle-props", string({ metavar: "REGEX" }), {
      description: message`Mangle properties matching this regex`,
    }),
  ),
  minify: optional(
    option("--minify", {
      description: message`Minify output (shorthand for all minify flags)`,
    }),
  ),
  minifyWhitespace: optional(
    option("--minify-whitespace", { description: message`Minify whitespace` }),
  ),
  minifyIdentifiers: optional(
    option("--minify-identifiers", {
      description: message`Minify identifiers`,
    }),
  ),
  minifySyntax: optional(
    option("--minify-syntax", { description: message`Minify syntax` }),
  ),
  pure: map(multiple(option("--pure", string({ metavar: "FUNC" }))), (arr) => [
    ...arr,
  ]),
  treeShaking: map(
    optional(
      option("--tree-shaking", string({ metavar: "MODE" }), {
        description: message`Tree shaking mode (true, false, or ignore-annotations)`,
      }),
    ),
    (s) => (s === "true" ? true : s === "false" ? false : s),
  ),

  // Source maps
  sourcemap: optional(
    option(
      "--sourcemap",
      choice(["inline", "external", "both", "linked"], { metavar: "MODE" }),
      {
        description: message`Sourcemap mode (inline, external, both, linked, or bare --sourcemap for true)`,
      },
    ),
  ),
  sourceRoot: optional(
    option("--source-root", string({ metavar: "ROOT" }), {
      description: message`Source root for source maps`,
    }),
  ),
  sourcesContent: optional(
    option("--sources-content", {
      description: message`Include sources content in source maps`,
    }),
  ),

  // Metadata
  metafile: optional(
    option("--metafile", { description: message`Generate a metadata file` }),
  ),
  analyze: optional(
    option("--analyze", { description: message`Print built file analysis` }),
  ),

  // Logging
  color: optional(
    option("--color", { description: message`Enable color in output` }),
  ),
  logLevel: optional(
    option(
      "--log-level",
      choice(["verbose", "debug", "info", "warning", "error", "silent"], {
        metavar: "LEVEL",
      }),
      {
        description: message`Log level`,
      },
    ),
  ),
  logLimit: optional(
    option("--log-limit", integer({ metavar: "N" }), {
      description: message`Log message limit`,
    }),
  ),
  logOverride: map(
    multiple(option("--log-override", string({ metavar: "KEY=LEVEL" }))),
    (arr) => Object.fromEntries(arr.map((s) => splitEq(s))),
  ),
});

// --- COMMAND ---

export default createCommand({
  name: "esbuild",
  parser: esbuildParser,
  aliases: ["build"],
  description: message`Bundle files using esbuild`,
  usage: message`esbuild [entry_points..] [options]`,
  brief: message`Bundle files using esbuild`,

  transformArgs: preprocessArgs,

  execute: async (parsed, terminal) => {
    const configPath = parsed.config || "esbuild.config.json";

    let rawConfig;
    try {
      const content = await terminal.fs.readFile(configPath, {
        encoding: "utf8",
      });
      rawConfig = JSON.parse(content);
    } catch (e) {
      if (parsed.config) {
        terminal.error(`${configPath}: ${e.message}`);
        return;
      }
      rawConfig = {};
    }

    const configResult = esbuildConfigSchema.safeParse(rawConfig);
    if (!configResult.success) {
      terminal.error(
        `${configPath}: ${configResult.error.issues.map((i) => i.message).join(", ")}`,
      );
      return;
    }
    const validatedConfig = configResult.data;

    const { config: _, ...cliFields } = parsed;
    const mergedResult = esbuildConfigSchema.safeParse({
      ...validatedConfig,
      ...cliFields,
    });
    if (!mergedResult.success) {
      terminal.error(
        `Config merge: ${mergedResult.error.issues.map((i) => i.message).join(", ")}`,
      );
      return;
    }
    const merged = mergedResult.data;

    const watchMode = merged.watch;
    const { watch: _w, entryPoints: epPatterns, ...rest } = merged;

    const isMatch = picomatch(epPatterns.map((/** @type {string} */ p) => p.replace(/^\.\//, "")));
    const matched = await terminal.fs.getFilesFromDirectory("", isMatch);
    const resolvedEntryPoints =
      matched.length > 0
        ? matched.map(([p]) => `/${p}`)
        : epPatterns.map((/** @type {string} */ p) => (p.startsWith("/") ? p : `/${p}`));

    const buildOptions = {
      ...rest,
      entryPoints: resolvedEntryPoints,
      write: false,
      plugins: [aliasPlugin(), httpPlugin(), fsPlugin(terminal.fs)],
    };

    if (watchMode) {
      const esbuild = await getEsbuild();
      const { analyze, ...watchOptions } = buildOptions;
      const context = await esbuild.context({
        ...watchOptions,
        write: false,
        metafile: true,
      });
      const result = await context.rebuild();
      for (const output of result.outputFiles ?? []) {
        await terminal.fs.writeFile(output.path, output.contents);
        terminal.success(
          `Wrote ${output.path} (${output.contents.length} bytes)`,
        );
      }
      let filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map(
        (v) => v.split(":")[1],
      );
      /** @type {(e: CustomEvent) => Promise<void>} */
      const handler = async (e) => {
        const path = /** @type {any} */ (e).detail?.path;
        if (!path) return;
        if (filesToWatch.includes(path)) {
          try {
            const result = await context.rebuild();
            filesToWatch = Object.keys(result.metafile?.inputs ?? {}).map(
              (v) => v.split(":")[1],
            );
            for (const output of result.outputFiles ?? []) {
              await terminal.fs.writeFile(output.path, output.contents);
              terminal.info(
                `Rebuilt ${output.path} (${output.contents.length} bytes)`,
              );
            }
          } catch (err) {
            terminal.error(
              `Rebuild failed: ${/** @type {any} */ (err).message}`,
            );
          }
        }
      };
      terminal.addEventListener("fs:modified", handler);
      const stopBtn = document.createElement("button");
      stopBtn.textContent = "⏹ stop watching";
      stopBtn.addEventListener("click", () => {
        context.dispose();
        terminal.removeEventListener("fs:modified", handler);
        stopBtn.remove();
      });
      terminal.log(stopBtn);
    } else {
      const esbuild = await getEsbuild();
      const { analyze, ..._buildOptions } = buildOptions;
      const result = await esbuild.build({
        ..._buildOptions,
        plugins: [fsPlugin(terminal.fs)],
      });
      for (const output of result.outputFiles ?? []) {
        await terminal.fs.writeFile(output.path, output.contents);
        terminal.success(
          `Wrote ${output.path} (${output.contents.length} bytes)`,
        );
      }
      if (result.metafile) {
        terminal.info(
          `Metafile: ${Object.keys(result.metafile.inputs).length} inputs, ${Object.keys(result.metafile.outputs).length} outputs`,
        );
      }
    }
  },
});
