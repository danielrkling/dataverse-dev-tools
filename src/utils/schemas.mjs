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

export const esbuildConfigSchema = z
  .object({
    entryPoints: dropEmpty(z.array(z.string()).default(["./src/app.ts"])),
    outdir: z.string().default("dist"),
    minify: z.boolean().default(false),
    bundle: z.boolean().default(true),
    format: z.enum(["iife", "cjs", "esm"]).default("esm"),
    platform: z.enum(["browser", "node", "neutral"]).default("browser"),
    sourcemap: z.union([z.boolean(), z.string()]).default("inline"),
    splitting: z.boolean().default(false),
    outExtension: dropEmpty(
      z.record(z.string(), z.string()).default({ ".js": ".mjs" }),
    ),
    target: z.union([z.string(), z.array(z.string())]).optional(),
    tsconfig: z.string().optional(),
    metafile: z.boolean().optional(),
    define: dropEmpty(z.record(z.string(), z.string()).optional()),
    alias: dropEmpty(z.record(z.string(), z.string()).optional()),
    loader: dropEmpty(z.record(z.string(), z.string()).optional()),
    external: dropEmpty(z.array(z.string()).optional()),
    watch: dropEmpty(
      z.union([z.array(z.string()), z.boolean()]).default(["src"]),
    ),
  })
  .passthrough();

export const dataverseConfigSchema = z.object({
  prefix: z.string().default(""),
  preview: z.string().default("index.html"),
  refresh: z.string().default("onUpload"),
  solution: z.string().default(""),
  files: dropEmpty(z.array(z.string()).default([])),
});

export const tailwindConfigSchema = z.object({
  content: dropEmpty(z.array(z.string()).default(["./src"])),
  extensions: dropEmpty(
    z.array(z.string()).default(["html", "js", "ts", "jsx", "tsx", "mjs"]),
  ),
  css: z
    .union([z.string(), z.array(z.string())])
    .default(['@import "tailwindcss"']),
  outfile: z.string().default("./dist/tailwind.css"),
  importCSS: z.string().optional(),
  plugins: dropEmpty(z.array(z.string()).default([])),
});
