/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'init-config',
  commands: [
    {
      name: 'init-config',
      aliases: ['ic'],
      description: 'Create default config files',
      usage: 'init-config [prefix]',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        const dcExists = await fs.exists('dataverse.config.json');
        const ecExists = await fs.exists('esbuild.config.json');
        if (dcExists && ecExists) {
          return 'Config files already exist. Delete them first to regenerate.';
        }

        if (!dcExists) {
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
        }

        if (!ecExists) {
          const esbuildConfig = {
            entryPoints: ['./src/app.ts'],
            outdir: 'dist',
            minify: false,
            format: 'esm',
            platform: 'browser',
            sourcemap: 'inline',
            splitting: false,
            outExtension: { '.js': '.mjs' },
            watch: ['src'],
          };
          await fs.writeFile('esbuild.config.json', JSON.stringify(esbuildConfig, null, 2));
          term.success('Created esbuild.config.json');
        }

        return '';
      },
    },
  ],
};
