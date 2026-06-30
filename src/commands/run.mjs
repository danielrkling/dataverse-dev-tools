import { Plugin } from '../plugin.mjs';
import { bundleToString } from './esbuild.mjs';
import { readJSON } from '../utils/json.mjs';
import { parseArgs } from '../utils/args.mjs';

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

function captureConsole(term, noCapture) {
  if (noCapture) return () => {};

  console.log = (...args) => {
    term.log(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));
  };
  console.warn = (...args) => {
    term.log(args.map(a => String(a)).join(' '), { class: 'log-warning' });
  };
  console.error = (...args) => {
    term.error(args.map(a => String(a)).join(' '));
  };
  console.info = (...args) => {
    term.info(args.map(a => String(a)).join(' '));
  };

  return () => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.info = originalConsole.info;
  };
}

export default class RunPlugin extends Plugin {
  get name() { return 'run' }
  get commands() { return [
    {
      name: 'run',
      description: 'Execute a file in the terminal context',
      usage: 'run [--bundle] [--no-capture] [--tsconfig] <file>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        const { flags, positional } = parseArgs(args);
        const raw = flags.raw;
        const noCapture = flags['no-capture'];
        const useTsconfig = flags.tsconfig;
        const file = positional[0];

        if (!file) return 'Usage: run [--raw] [--no-capture] [--tsconfig] <file>';

        try {
          let code = await fs.readFile(file, { encoding: 'utf8' });
          const restore = captureConsole(term, noCapture);

          try {
            if (!raw) {
              const fileConfig = await readJSON(fs, 'esbuild.config.json') || {};
              const { watch: _w, plugins: _p, ...baseConfig } = fileConfig;

              let esbuildConfig = {
                ...baseConfig,
                entryPoints: [file],
                bundle: true,
                format: 'iife',
                write: false,
              };

              if (useTsconfig) {
                const tsconfig = await readJSON(fs, 'tsconfig.json');
                if (tsconfig?.compilerOptions) {
                  const { target, jsx, jsxFactory, jsxFragmentFactory } = tsconfig.compilerOptions;
                  if (target) esbuildConfig.target = target.toLowerCase();
                  if (jsx) esbuildConfig.jsx = jsx;
                  if (jsxFactory) esbuildConfig.jsxFactory = jsxFactory;
                  if (jsxFragmentFactory) esbuildConfig.jsxFragment = jsxFragmentFactory;
                }
              }

              const outputs = await bundleToString(fs, esbuildConfig);
              if (outputs.length === 0) return 'run: no output from bundler';
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
            return result !== undefined ? String(result) : '';
          } finally {
            restore();
          }
        } catch (e) {
          return `run: ${e.message}`;
        }
      },
    },
    ];
  }
}
