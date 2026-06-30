import { Plugin } from '../plugin.mjs';

/** @type {Set<Window>} */
const previewWindows = new Set();

/** @param {Window} win */
function registerPreviewWindow(win) {
  previewWindows.add(win);
}

export default class PreviewPlugin extends Plugin {
  get name() { return 'preview' }
  get commands() {
    return [
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
              const config = JSON.parse(/** @type {string} */ (await fs.readFile('dataverse.config.json', { encoding: 'utf8' })));
              path = config.upload?.preview;
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
    ];
  }
  /** @param {import('../plugin.mjs').InitContext} ctx */
  async init({ pm }) {
    const unsub1 = pm.on('publish:complete', () => {
      for (const win of previewWindows) {
        try { win.location.reload(); } catch { previewWindows.delete(win); }
      }
    });
    const unsub2 = pm.on('preview:refresh', () => {
      for (const win of previewWindows) {
        try { win.location.reload(); } catch { previewWindows.delete(win); }
      }
    });
    return () => { unsub1(); unsub2(); };
  }
}
