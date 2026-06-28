/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'init-config',
  commands: [
    {
      name: 'init-config',
      aliases: ['ic'],
      description: 'Create default config files',
      usage: 'init-config [prefix] [--tailwind] [--tsc]',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        const withTailwind = args.includes('--tailwind');
        const withTsc = args.includes('--tsc');
        const prefix = args.find(a => !a.startsWith('--')) || '';

        const dcExists = await fs.exists('dataverse.config.json');
        const ecExists = await fs.exists('esbuild.config.json');
        const tcExists = await fs.exists('tailwind.config.json');

        const tscExists = await fs.exists('tsconfig.json');
        if (dcExists && ecExists && (!withTailwind || tcExists) && (!withTsc || tscExists)) {
          return 'Config files already exist. Delete them first to regenerate.';
        }

        if (!dcExists) {
          const config = {
            upload: {
              prefix: prefix || '',
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

        if (withTsc) {
          const tsconfig = {
            compilerOptions: {
              target: 'ES2022',
              module: 'ES2022',
              moduleResolution: 'bundler',
              strict: true,
              jsx: 'preserve',
              esModuleInterop: true,
              skipLibCheck: true,
              outDir: './dist',
              rootDir: './src',
            },
            include: ['./src'],
            exclude: ['node_modules', 'dist'],
          };
          await fs.writeFile('tsconfig.json', JSON.stringify(tsconfig, null, 2));
          term.success('Created tsconfig.json');
        }

        if (withTailwind && !tcExists) {
          const tailwindConfig = {
            content: ['./src'],
            extensions: ['html', 'js', 'jsx', 'tsx'],
            css: './src/tailwind.css',
            outfile: './dist/tailwind.css',
            importCSS: '@import "tailwindcss";',
            plugins: [],
          };
          await fs.writeFile('tailwind.config.json', JSON.stringify(tailwindConfig, null, 2));
          term.success('Created tailwind.config.json');

          const tcCssExists = await fs.exists('./src/tailwind.css');
          if (!tcCssExists) {
            await fs.mkdir('src', { recursive: true });
            await fs.writeFile('src/tailwind.css', '@import "tailwindcss";\n');
            term.success('Created src/tailwind.css');
          }
        }

        return '';
      },
    },
  ],
};
