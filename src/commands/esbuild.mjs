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
        let config;
        try {
          const raw = await fs.readFile('esbuild.config.json', { encoding: 'utf8' });
          config = JSON.parse(/** @type {string} */ (raw));
        } catch {
          return 'No esbuild.config.json found. Run init-config to create it.';
        }
        try {
          const files = await bundle_in_memory(fs, config);
          return `Built ${files.map(v => v.path).join(', ')}`;
        } catch (e) {
          return `esbuild failed: ${e.message}`;
        }
      },
    },
  ],
};
