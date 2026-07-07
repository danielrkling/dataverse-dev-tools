import { z } from "zod";

/**
 * Drops empty values from a schema
 * @param {import("zod").ZodTypeAny} schema - The schema to preprocess
 * @returns {import("zod").ZodTypeAny} - The preprocessed schema
 */
function dropEmpty(schema) {
  return z.preprocess((val) => {
    if (val === undefined) return undefined;
    if (Array.isArray(val) && val.length === 0) return undefined;
    if (
      typeof val === "object" &&
      val !== null &&
      !Array.isArray(val) &&
      Object.keys(val).length === 0
    )
      return undefined;
    return val;
  }, schema);
}

export const esbuildConfigSchema = z.object({
  // Input
  entryPoints: dropEmpty(
    z.union([z.string(), z.array(z.string())])
      .transform(v => typeof v === "string" ? [v] : v)
      .default(["./src/app.ts"]),
  ),
  loader: dropEmpty(z.record(z.string(), z.string()).optional()),

  // Output contents
  format: z.enum(["iife", "cjs", "esm"]).default("esm"),
  splitting: z.boolean().default(false),
  banner: dropEmpty(z.object({ js: z.string().optional(), css: z.string().optional() }).optional()),
  footer: dropEmpty(z.object({ js: z.string().optional(), css: z.string().optional() }).optional()),
  charset: z.enum(["utf8", "ascii"]).optional(),
  globalName: z.string().optional(),
  legalComments: z.enum(["none", "inline", "eof", "linked", "external"]).optional(),
  lineLimit: z.number().optional(),

  // Output location
  outdir: z.string().default("dist"),
  outfile: z.string().optional(),
  outbase: z.string().optional(),
  outExtension: dropEmpty(z.record(z.string(), z.string()).default({ ".js": ".mjs" })),
  entryNames: z.string().optional(),
  chunkNames: z.string().optional(),
  assetNames: z.string().optional(),
  publicPath: z.string().optional(),
  write: z.boolean().optional(),
  allowOverwrite: z.boolean().optional(),

  // Path resolution
  alias: dropEmpty(z.record(z.string(), z.string()).optional()),
  conditions: dropEmpty(z.array(z.string()).optional()),
  external: dropEmpty(z.array(z.string()).optional()),
  mainFields: dropEmpty(z.array(z.string()).optional()),
  nodePaths: dropEmpty(z.array(z.string()).optional()),
  packages: z.enum(["external"]).optional(),
  preserveSymlinks: z.boolean().optional(),
  resolveExtensions: dropEmpty(z.array(z.string()).optional()),
  absWorkingDir: z.string().optional(),

  // Transformation
  jsx: z.enum(["transform", "preserve", "automatic"]).optional(),
  jsxDev: z.boolean().optional(),
  jsxFactory: z.string().optional(),
  jsxFragment: z.string().optional(),
  jsxImportSource: z.string().optional(),
  jsxSideEffects: z.boolean().optional(),
  supported: dropEmpty(z.record(z.string(), z.boolean()).optional()),
  target: z.union([z.string(), z.array(z.string())]).optional(),
  tsconfig: z.string().optional(),

  // Optimization
  define: dropEmpty(z.record(z.string(), z.string()).optional()),
  drop: dropEmpty(z.array(z.enum(["console", "debugger"])).optional()),
  dropLabels: dropEmpty(z.array(z.string()).optional()),
  ignoreAnnotations: z.boolean().optional(),
  inject: dropEmpty(z.array(z.string()).optional()),
  keepNames: z.boolean().optional(),
  mangleProps: z.string().optional().transform((v) => (v ? new RegExp(v) : undefined)),
  mangleQuoted: z.boolean().optional(),
  reserveProps: z.string().optional().transform((v) => (v ? new RegExp(v) : undefined)),
  minify: z.boolean().default(false),
  minifyWhitespace: z.boolean().optional(),
  minifyIdentifiers: z.boolean().optional(),
  minifySyntax: z.boolean().optional(),
  pure: dropEmpty(z.array(z.string()).optional()),
  treeShaking: z.boolean().optional(),

  // Source maps
  sourcemap: z.union([z.boolean(), z.enum(["inline", "external", "both"])]).default("inline"),
  sourceRoot: z.string().optional(),
  sourcesContent: z.boolean().optional(),

  // Metadata
  metafile: z.boolean().optional(),
  analyze: z.boolean().optional(),

  // General
  bundle: z.boolean().default(true),
  platform: z.enum(["browser", "node", "neutral"]).default("browser"),
  watch: z.boolean().optional(),

  // Logging
  color: z.boolean().optional(),
  logLevel: z.enum(["verbose", "debug", "info", "warning", "error", "silent"]).optional(),
  logLimit: z.number().optional(),
  logOverride: dropEmpty(z.record(z.string(), z.string()).optional()),
});

export const dataverseConfigSchema = z.object({
  prefix: z.string().default(""),
  preview: z.string().default("index.html"),
  refresh: z.string().default("onUpload"),
  solution: z.string().default(""),
  files: dropEmpty(z.array(z.string()).default([])),
});

export const tailwindConfigSchema = z.object({
  content: dropEmpty(
    z.union([z.string(), z.array(z.string())])
      .transform(v => typeof v === "string" ? [v] : v)
      .default(["./src/**/*.{html,js,ts,jsx,tsx,mjs}"]),
  ),
  css: z
    .union([z.string(), z.array(z.string())])
    .default(['@import "tailwindcss"']),
  outfile: z.string().default("./dist/tailwind.css"),
  importCSS: z.string().optional(),
  plugins: dropEmpty(z.array(z.string()).default([])),
});
