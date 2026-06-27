/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'init-config',
  commands: [
    {
      name: 'init-config',
      aliases: ['ic'],
      description: 'Create a dataverse.config.json with default values',
      usage: 'init-config [prefix]',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        const exists = await fs.exists('dataverse.config.json');
        if (exists) {
          return 'dataverse.config.json already exists. Delete it first to regenerate.';
        }

        const config = {
          upload: {
            prefix: args[0] || '',
            watch: ['src', 'dist'],
            preview: 'index.html',
            refresh: 'onUpload',
            solution: '',
          },
        };

        await fs.writeFile('dataverse.config.json', JSON.stringify(config, null, 2));
        term.success('Created dataverse.config.json');
        if (!config.upload.prefix) {
          term.info('Set the "prefix" field in dataverse.config.json to enable file watching.');
        }
        return '';
      },
    },
  ],
};
