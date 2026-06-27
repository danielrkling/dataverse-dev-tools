/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'run',
  commands: [
    {
      name: 'run',
      description: 'Execute a JavaScript file in the terminal context',
      usage: 'run <file>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (!args[0]) return 'Usage: run <file>';
        try {
          const code = await fs.readFile(args[0], { encoding: 'utf8' });
          const result = await new Function(`
            const module = { exports: {} };
            const exports = module.exports;
            return (async () => {
              ${code}
              return module.exports;
            })();
          `)();
          return result !== undefined ? String(result) : '';
        } catch (e) {
          return `run: ${e.message}`;
        }
      },
    },
  ],
};
