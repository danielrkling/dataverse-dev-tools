import { createCommand } from "../terminal.mjs";
import {
  object,
  optional,
  argument,
  string,
  flag,
  message,
} from "@optique/core";

const initConfigParser = object({
  esbuild: flag("--esbuild", {
    description: message`Generate esbuild config file`,
  }),
  tailwind: flag("--tailwind", {
    description: message`Generate tailwind config file`,
  }),
  tsc: flag("--tsc", { description: message`Generate tsconfig file` }),
  prefix: optional(
    argument(string({ metavar: "PREFIX" }), {
      description: message`Prefix for solution web resources`,
    }),
  ),
});

export const initConfig = createCommand({
  name: "init-config",
  parser: initConfigParser,
  aliases: ["ic"],
  description: "Create default config files",
  usage: "init-config [prefix] [--esbuild] [--tailwind] [--tsc]",
  brief: "Create default config files",
  execute: async (parsed, term) => {
    const { fs } = term;
    const withEsbuild = parsed.esbuild;
    const withTailwind = parsed.tailwind;
    const withTsc = parsed.tsc;
    const prefix = parsed.prefix || "";

    const dcExists = await fs.exists("dataverse.config.json");
    const ecExists = !withEsbuild || (await fs.exists("esbuild.config.json"));
    const tcExists = !withTailwind || (await fs.exists("tailwind.config.json"));
    const tscExists = !withTsc || (await fs.exists("tsconfig.json"));
    if (dcExists && ecExists && tcExists && tscExists) {
      return "Config files already exist. Delete them first to regenerate.";
    }

    if (!dcExists) {
      const config = {
        upload: {
          prefix: prefix || "",
          watch: ["src", "dist"],
          preview: "index.html",
          refresh: "onUpload",
          solution: "",
        },
      };
      await fs.writeFile(
        "dataverse.config.json",
        JSON.stringify(config, null, 2),
      );
      term.success("Created dataverse.config.json");
      if (!config.upload.prefix) {
        term.info(
          'Set the "prefix" field in dataverse.config.json to enable file watching.',
        );
      }
    }

    if (withEsbuild && !ecExists) {
      const esbuildConfig = {
        entryPoints: ["./src/app.ts"],
        outdir: "dist",
        minify: false,
        format: "esm",
        platform: "browser",
        sourcemap: "inline",
        splitting: false,
        outExtension: { ".js": ".mjs" },
        watch: ["src"],
      };
      await fs.writeFile(
        "esbuild.config.json",
        JSON.stringify(esbuildConfig, null, 2),
      );
      term.success("Created esbuild.config.json");
    }

    if (withTsc) {
      const tsconfig = {
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          strict: true,
          jsx: "preserve",
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: "./dist",
          rootDir: "./src",
        },
        include: ["./src"],
        exclude: ["node_modules", "dist"],
      };
      await fs.writeFile("tsconfig.json", JSON.stringify(tsconfig, null, 2));
      term.success("Created tsconfig.json");
    }

    if (withTailwind && !tcExists) {
      const tailwindConfig = {
        content: ["./src"],
        extensions: ["html", "js", "jsx", "tsx"],
        css: "./src/tailwind.css",
        outfile: "./dist/tailwind.css",
        importCSS: '@import "tailwindcss";',
        plugins: [],
      };
      await fs.writeFile(
        "tailwind.config.json",
        JSON.stringify(tailwindConfig, null, 2),
      );
      term.success("Created tailwind.config.json");

      const tcCssExists = await fs.exists("./src/tailwind.css");
      if (!tcCssExists) {
        await fs.mkdir("src", { recursive: true });
        await fs.writeFile("src/tailwind.css", '@import "tailwindcss";\n');
        term.success("Created src/tailwind.css");
      }
    }

    return "";
  },
});
