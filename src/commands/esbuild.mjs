import { bundle_in_memory } from '../esbuild.mjs';

/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'esbuild',
  commands: [
    {
      name: 'esbuild',
      aliases: ['build'],
      description: 'Bundle files using esbuild',
      usage: 'esbuild',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (!fs) return 'No file system.';
        try {
          const files = await bundle_in_memory(fs, {
            entryPoints: ['./src/app.ts'],
            bundle: true,
            outdir: 'dist',
            minify: false,
            format: 'esm',
            platform: 'browser',
            sourcemap: 'inline',
            splitting: false,
            outExtension: { '.js': '.mjs' },
          });
          return `Built ${files.map(v => v.path).join(', ')}`;
        } catch (e) {
          return `esbuild failed: ${e.message}`;
        }
      },
    },
  ],
};
