import { createCommand, WebTerminal } from "../terminal.mjs";
import { bundleToString } from "./esbuild.mjs";
import { readJSON } from "../utils/json.mjs";
import { object, flag, argument, string, message } from "@optique/core";

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

/**
 *
 * @param {WebTerminal} term
 * @param {boolean} noCapture
 * @returns
 */
function captureConsole(term, noCapture) {
  if (noCapture) return () => {};

  console.log = (...args) => {
    term.log(
      args
        .map((a) =>
          typeof a === "object" ? JSON.stringify(a, null, 2) : String(a),
        )
        .join(" "),
    );
  };
  console.warn = (...args) => {
    term.log(args.map((a) => String(a)).join(" "), { class: "log-warning" });
  };
  console.error = (...args) => {
    term.error(args.map((a) => String(a)).join(" "));
  };
  console.info = (...args) => {
    term.info(args.map((a) => String(a)).join(" "));
  };

  return () => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.info = originalConsole.info;
  };
}

const runCommandParser = object({
  raw: flag("--raw", {
    description: message`Do not bundle the file using esbuild`,
  }),
  noCapture: flag("--no-capture", {
    description: message`Do not capture and redirect console outputs`,
  }),
  tsconfig: flag("--tsconfig", {
    description: message`Merge compiler options from tsconfig.json`,
  }),
  file: argument(string({ metavar: "FILE" }), {
    description: message`File to execute`,
  }),
});

export const runCommand = createCommand({
  name: "run",
  parser: runCommandParser,
  description: "Execute a file in the terminal context",
  usage: "run [--raw] [--no-capture] [--tsconfig] <file>",
  brief: "Execute a file in the terminal context",
  execute: async (parsed, term) => {
    const { fs } = term;
    const raw = parsed.raw;
    const noCapture = parsed.noCapture;
    const useTsconfig = parsed.tsconfig;
    const file = parsed.file;

    try {
      let code = await fs.readFile(file, { encoding: "utf8" });
      const restore = captureConsole(term, noCapture);

      try {
        if (!raw) {
          const fileConfig = (await readJSON(fs, "esbuild.config.json")) || {};
          const { watch: _w, plugins: _p, ...baseConfig } = fileConfig;

          let esbuildConfig = {
            ...baseConfig,
            entryPoints: [file],
            bundle: true,
            format: "iife",
            write: false,
          };

          if (useTsconfig) {
            const tsconfig = await readJSON(fs, "tsconfig.json");
            if (tsconfig?.compilerOptions) {
              const { target, jsx, jsxFactory, jsxFragmentFactory } =
                tsconfig.compilerOptions;
              if (target) esbuildConfig.target = target.toLowerCase();
              if (jsx) esbuildConfig.jsx = jsx;
              if (jsxFactory) esbuildConfig.jsxFactory = jsxFactory;
              if (jsxFragmentFactory)
                esbuildConfig.jsxFragment = jsxFragmentFactory;
            }
          }

          const outputs = await bundleToString(fs, esbuildConfig);
          if (outputs.length === 0) return "run: no output from bundler";
          code = outputs[0].text;
        }

        const result = await new Function(`
              const module = { exports: {} };
              const exports = module.exports;
              return (async () => {
                ${code}
                return module.exports;
              })();
            `)();
        return result !== undefined ? String(result) : "";
      } finally {
        restore();
      }
    } catch (e) {
      return `run: ${e.message}`;
    }
  },
});
