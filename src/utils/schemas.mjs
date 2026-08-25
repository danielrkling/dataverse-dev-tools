import { z } from "zod";

/**
 * Drops empty values from a schema
 * @param {import("zod").ZodTypeAny} schema - The schema to transform
 * @returns {import("zod").ZodTypeAny} - The transformed schema
 */
function dropEmpty(schema) {
  return schema.transform((val) => {
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
  });
}

/**
 * Returns a shallow copy of an object with undefined / empty-array /
 * empty-object values removed, so CLI-provided empties never clobber
 * file-config values or schema defaults.
 * @param {Record<string, any> | null | undefined} obj
 * @returns {Record<string, any>}
 */
function withoutEmpty(obj) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    )
      continue;
    out[key] = value;
  }
  return out;
}

/**
 * Schema for esbuild.config.json / CLI merge.
 * Defaults mirror what the build command needs to run standalone.
 */
export const esbuildConfigSchema = z.preprocess(withoutEmpty, z.object({
  entryPoints: z.array(z.string()).default(["./src/app.ts"]),
  outdir: z.string().default("dist"),
  bundle: z.boolean().default(true),
  minify: z.boolean().default(false),
  format: z.enum(["iife", "cjs", "esm"]).default("esm"),
  platform: z.enum(["browser", "node", "neutral"]).default("browser"),
  sourcemap: z.union([z.boolean(), z.enum(["inline", "external", "both"])]).default("inline"),
  splitting: z.boolean().default(false),
  outExtension: z.record(z.string(), z.string()).default({ ".js": ".mjs" }),
  target: z.string().optional(),
  outfile: z.string().optional(),
  globalName: z.string().optional(),
  tsconfig: z.string().optional(),
  mainFields: dropEmpty(z.array(z.string())).optional(),
  alias: dropEmpty(z.record(z.string(), z.string())).optional(),
  resolveExtensions: dropEmpty(z.array(z.string())).optional(),
  define: dropEmpty(z.record(z.string(), z.string())).optional(),
  external: dropEmpty(z.array(z.string())).optional(),
  banner: z.string().optional(),
  footer: z.string().optional(),
  charset: z.enum(["utf8", "ascii"]).optional(),
  treeShaking: z.boolean().optional(),
  jsx: z.enum(["transform", "preserve", "automatic"]).optional(),
  jsxFactory: z.string().optional(),
  jsxFragment: z.string().optional(),
  loader: dropEmpty(z.record(z.string(), z.string())).optional(),
  logLevel: z.enum(["verbose", "debug", "info", "warning", "error", "silent"]).optional(),
  logLimit: z.number().int().optional(),
  watch: z.boolean().optional(),
}));

/**
 * Schema for dataverse.config.json
 */
export const dataverseConfigSchema = z.object({
  /** Publisher prefix used for web resource names (e.g. "myapp") */
  prefix: z.string().optional(),
  /** Web resource path opened by the `preview` command when no path is given */
  preview: z.string().optional(),
  /** When to refresh a published preview window ("onUpload", ...) */
  refresh: z.string().optional(),
  /** Solution unique name to add/upload web resources into */
  solution: z.string().optional(),
  /** Glob patterns describing which files belong to the project */
  files: z.array(z.string()).optional(),
});

/**
 * Schema for tailwind.config.json
 */
export const tailwindConfigSchema = z.object({
  /** Globs or directories to scan for class names */
  content: z.union([z.string(), z.array(z.string())]).optional(),
  /** CSS entry: inline import text, or path(s) to stylesheet(s) */
  css: z.union([z.string(), z.array(z.string())]).optional(),
  /** Output file for the compiled CSS */
  outfile: z.string().optional(),
  /** Tailwind plugins to load */
  plugins: z.array(z.string()).optional(),
});
