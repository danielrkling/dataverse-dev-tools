/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'tailwind',
  commands: [
    {
      name: 'tailwind',
      aliases: ['tw'],
      description: 'Generate Tailwind CSS from content files',
      usage: 'tailwind [build|watch]',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        const sub = args[0];
        try {
          if (sub === 'watch') return await handleWatch(args.slice(1), term, fs);
          return await handleBuild(args, term, fs);
        } catch (e) {
          return `tailwind: ${e.message}`;
        }
      },
    },
  ],
};

const CDN_URL = 'https://cdn.jsdelivr.net/npm/tailwindcss-iso@1.0.6/dist/browser.js';

/** @type {import('tailwindcss-iso').generateTailwindCSS | null} */
let _generateTailwindCSS = null;

/** @returns {Promise<import('tailwindcss-iso').generateTailwindCSS>} */
async function getGenerateTailwindCSS() {
  if (!_generateTailwindCSS) {
    const mod = await import(CDN_URL);
    _generateTailwindCSS = mod.generateTailwindCSS;
  }
  return _generateTailwindCSS;
}

/**
 * Given a path, return a watchable directory.
 * If it's a file, returns its parent directory.
 * Returns null if the path doesn't exist.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function watchDir(fs, path) {
  try {
    const stat = await fs.stat(path);
    if (stat.isDirectory) return path;
    const parts = path.split('/');
    parts.pop();
    return parts.join('/') || '.';
  } catch {
    return null;
  }
}

/**
 * Read all content files and return their concatenated contents.
 * Each entry can be a file (read directly) or directory (recursively scanned).
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string[]} entries
 * @param {string[]|null} [extensions] Optional — only include files with these extensions
 * @returns {Promise<string>}
 */
export async function collectContent(fs, entries, extensions) {
  let allContent = '';

  for (const entry of entries) {
    let files;
    try {
      files = await fs.getFilesFromDirectory(entry);
    } catch {
      continue;
    }

    for (const [filePath, content] of Object.entries(files)) {
      if (extensions && extensions.length > 0) {
        const dot = filePath.lastIndexOf('.');
        if (dot === -1) continue;
        if (!extensions.includes(filePath.slice(dot + 1))) continue;
      }
      allContent += '\n' + content;
    }
  }

  return allContent;
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {Promise<object>}
 */
async function readConfig(fs) {
  try {
    const raw = await fs.readFile('tailwind.config.json', { encoding: 'utf8' });
    return JSON.parse(/** @type {string} */ (raw));
  } catch {
    throw new Error('No tailwind.config.json found. Create one with content dirs, extensions, css path, and outfile.');
  }
}

/**
 * @param {string[]} args
 * @param {import('../terminal.mjs').WebTerminal} term
 * @param {import('../fs.mjs').WebFileSystem} fs
 */
async function handleBuild(args, term, fs) {
  const config = await readConfig(fs);
  const dirs = config.content || ['.'];

  term.log('Scanning content files...');
  const content = await collectContent(fs, dirs, config.extensions || null);

  let css = '';
  if (config.css) {
    try {
      css = await fs.readFile(config.css, { encoding: 'utf8' });
    } catch {
      term.info(`CSS file "${config.css}" not found — proceeding without it`);
    }
  }

  if (config.plugins) {
    for (const pluginPath of config.plugins) {
      try {
        const pluginCss = await fs.readFile(pluginPath, { encoding: 'utf8' });
        css += '\n' + pluginCss;
      } catch {
        term.error(`Plugin CSS not found: ${pluginPath}`);
      }
    }
  }

  term.log('Generating Tailwind CSS...');
  const generateTailwindCSS = await getGenerateTailwindCSS();
  const result = await generateTailwindCSS({
    content: content || ' ',
    css,
    importCSS: config.importCSS || '@import "tailwindcss";',
  });

  const outfile = config.outfile || './dist/tailwind.css';
  const parts = outfile.split('/');
  parts.pop();
  if (parts.length > 0) {
    try {
      await fs.mkdir(parts.join('/'), { recursive: true });
    } catch {}
  }
  await fs.writeFile(outfile, result);
  term.success(`Wrote ${outfile} (${result.length} bytes)`);
}

/**
 * @param {string[]} args
 * @param {import('../terminal.mjs').WebTerminal} term
 * @param {import('../fs.mjs').WebFileSystem} fs
 */
async function handleWatch(args, term, fs) {
  const config = await readConfig(fs);

  await handleBuild(args, term, fs);

  /** @type {Set<string>} */
  const watched = new Set();
  const dirs = config.content || ['.'];
  const extensions = config.extensions || null;

  const rebuild = async () => {
    try {
      await handleBuild(args, term, fs);
    } catch (e) {
      term.error(`Rebuild failed: ${e.message}`);
    }
  };

  for (const entry of dirs) {
    const dir = await watchDir(fs, entry);
    if (!dir || watched.has(dir)) continue;
    watched.add(dir);
    fs.watch(dir, { recursive: true, debounce: 300 }, async (path, type) => {
      if (type === 'modified' || type === 'created') {
        if (extensions) {
          const dot = path.lastIndexOf('.');
          if (dot === -1) return;
          if (!extensions.includes(path.slice(dot + 1))) return;
        }
        term.log(`Change: ${path}`);
        await rebuild();
      }
    }).catch(() => {});
  }

  if (config.css) {
    const cssDir = await watchDir(fs, config.css);
    if (cssDir && !watched.has(cssDir)) {
      watched.add(cssDir);
      const cssBasename = config.css.split('/').pop();
      fs.watch(cssDir, { recursive: true, debounce: 300 }, async (path, type) => {
        if (type === 'modified' && path.split('/').pop() === cssBasename) {
          term.log(`CSS config changed: ${path}`);
          await rebuild();
        }
      }).catch(() => {});
    }
  }

  term.info('Watching for changes...');
}
