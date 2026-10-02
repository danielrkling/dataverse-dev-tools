import { createCommand } from "../services/commands.mjs";
import { Effect } from "effect";
import { dataverseConfigSchema } from "./dataverse.mjs";
import { esbuildRawSchema } from "./esbuild.mjs";
import { tailwindConfigSchema } from "./tailwind.mjs";
import {
  object,
  optional,
  argument,
  string,
  option,
  message,
} from "@optique/core";

const initConfigParser = object({
  esbuild: optional(option("--esbuild", {
    description: message`Generate esbuild config file`,
  })),
  tailwind: optional(option("--tailwind", {
    description: message`Generate tailwind config file`,
  })),
  tsc: optional(option("--tsc", { description: message`Generate tsconfig file` })),
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
  description: message`Create default config files`,
  usage: message`init-config [prefix] [--esbuild] [--tailwind] [--tsc]`,
  brief: message`Create default config files`,
  /**
   * @param {Record<string, any>} parsed
   * @param {import("../types/terminal.d.ts").Terminal} term
   * @returns {Effect.Effect<string | undefined, Error>}
   */
  executeEffect: (parsed, term) => Effect.tryPromise(() => initConfigExecute(parsed, term)),
});

/**
 * Legacy synchronous body, wrapped by executeEffect above.
 * @param {Record<string, any>} parsed
 * @param {import("../types/terminal.d.ts").Terminal} term
 */
async function initConfigExecute(parsed, term) {
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
      // launderJs defaults to on; users with clean/non-OneDrive workspaces
      // can set it to false in dataverse.config.json or via `launder off`.
      const config = dataverseConfigSchema.parse({ prefix, launderJs: true });
      await fs.writeFile(
        "dataverse.config.json",
        JSON.stringify(config, null, 2),
      );
      term.success("Created dataverse.config.json");
      if (!config.prefix) {
        term.info(
          'Set the "prefix" field in dataverse.config.json to enable file watching.',
        );
      }
    }

    if (withEsbuild && !ecExists) {
      // Write only the shape's non-default keys. Materialising the defaults
      // here would pin minify/sourcemap in the config file, and since file
      // values outrank the --dev/--prod mode preset, `--prod` would silently
      // stop minifying.
      const esbuildConfig = esbuildRawSchema.parse({});
      await fs.writeFile(
        "esbuild.config.json",
        `${JSON.stringify(esbuildConfig, null, 2)}\n`,
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
      const tailwindConfig = tailwindConfigSchema.parse({});
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
}