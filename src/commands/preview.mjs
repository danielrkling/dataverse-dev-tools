import { registerPreviewWindow } from '../main.mjs';

/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'preview',
  commands: [
    {
      name: 'preview',
      aliases: ['pv'],
      description: 'Preview a web resource in a new tab',
      usage: 'preview [path]',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        let path = args[0];
        if (!path) {
          try {
            const pkg = JSON.parse(/** @type {string} */ (await fs.readFile('package.json', { encoding: 'utf8' })));
            path = pkg.webResourceKit?.upload?.preview;
          } catch {
            return 'No preview path configured and no path provided.';
          }
        }
        if (!path) return 'Could not determine preview path.';
        const url = `${location.origin}/WebResources/${path}`;
        const win = window.open(url);
        if (win) registerPreviewWindow(win);
        return `Opening ${url}`;
      },
    },
  ],
};
