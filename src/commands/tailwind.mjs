import { Plugin } from '../plugin.mjs';
import { dirname, basename, join } from '../utils/path.mjs';
import { readJSON } from '../utils/json.mjs';
import { bundleToString } from './esbuild.mjs';

const TAILWIND_VERSION = '4.1.6';
const DEFAULT_EXTENSIONS = ['html', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'css'];
const COMPILE_URL = `https://esm.sh/tailwindcss@${TAILWIND_VERSION}`;
const ISO_URL = 'https://cdn.jsdelivr.net/npm/tailwindcss-iso@1.0.6/dist/browser.js';
const CSS_BASE = `https://cdn.jsdelivr.net/npm/tailwindcss@${TAILWIND_VERSION}`;

const cssCache = new Map();
/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function getCSSAsset(name) {
  if (cssCache.has(name)) return cssCache.get(name);
  const url = `${CSS_BASE}/${name}.css`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch tailwindcss asset: ${name}`);
  const text = await res.text();
  cssCache.set(name, text);
  return text;
}

/** @type {((css: string, opts: any) => any) | null} */
let _compile = null;
/** @type {((opts: any) => any[]) | null} */
let _getTailwindClasses = null;

async function getCompile() {
  if (!_compile) {
    const mod = await import(COMPILE_URL);
    _compile = mod.compile;
  }
  return _compile;
}

async function ensureWasmLoaded() {
  if (!_getTailwindClasses) {
    const mod = await import(ISO_URL);
    _getTailwindClasses = mod.getTailwindClasses;
  }
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {(id: string, base: string) => Promise<{path: string, base: string, content: string}>}
 */
function createLoadStylesheet(fs) {
  return async (id, base) => {
    const name = id.replace(/\.css$/, '');
    if (name === 'tailwindcss') {
      return { path: 'virtual:tailwindcss/index.css', base: '/', content: await getCSSAsset('index') };
    }
    if (name === 'tailwindcss/preflight' || name === './preflight') {
      return { path: 'virtual:tailwindcss/preflight.css', base: '/', content: await getCSSAsset('preflight') };
    }
    if (name === 'tailwindcss/theme' || name === './theme') {
      return { path: 'virtual:tailwindcss/theme.css', base: '/', content: await getCSSAsset('theme') };
    }
    if (name === 'tailwindcss/utilities' || name === './utilities') {
      return { path: 'virtual:tailwindcss/utilities.css', base: '/', content: '@tailwind utilities;' };
    }

    if (id.startsWith('http://') || id.startsWith('https://')) {
      const res = await fetch(id);
      return { path: id, base, content: await res.text() };
    }

    const fullPath = base && base !== '/' ? join(base, id) : id;
    const content = await fs.readFile(fullPath, { encoding: 'utf8' });
    return { path: fullPath, base: dirname(fullPath) || '/', content };
  };
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {(id: string, base: string, resourceHint?: any) => Promise<{path: string, base: string, module: any}>}
 */
function createLoadModule(fs) {
  return async (id, base, resourceHint) => {
    if (id.startsWith('http://') || id.startsWith('https://')) {
      const mod = await import(id);
      return { path: id, base, module: mod.default || mod };
    }

    if (!id.startsWith('./') && !id.startsWith('../') && !id.startsWith('/')) {
      const mod = await import(`https://esm.sh/${id}`);
      return { path: id, base, module: mod.default || mod };
    }

    const fullPath = base && base !== '/' ? join(base, id) : id;
    const [bundled] = await bundleToString(fs, {
      entryPoints: [fullPath],
      bundle: true,
      format: 'esm',
      write: false,
    });
    const blob = new Blob([bundled.text], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      const mod = await import(url);
      return { path: fullPath, base: dirname(fullPath) || '/', module: mod.default || mod };
    } finally {
      URL.revokeObjectURL(url);
    }
  };
}

/**
 * @param {any} config
 * @returns {string}
 */
function buildCSSInput(config) {
  if (Array.isArray(config.css)) {
    return config.css.map(item => {
      const t = item.trim();
      if (t.startsWith('@') || t.startsWith('http://') || t.startsWith('https://')) return t;
      return `@import "${t}"`;
    }).join('\n');
  }
  const parts = [];
  if (config.importCSS) parts.push(config.importCSS);
  else parts.push('@import "tailwindcss"');
  if (config.css && typeof config.css === 'string') parts.push(`@import "${config.css}"`);
  if (config.plugins) {
    for (const p of config.plugins) {
      if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('./') || p.startsWith('/')) {
        parts.push(`@import "${p}"`);
      } else {
        parts.push(`@plugin "${p}"`);
      }
    }
  }
  return parts.join('\n');
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string[]} dirs
 * @param {string[]} extensions
 * @returns {Promise<string[]>}
 */
async function extractClasses(fs, dirs, extensions) {
  await ensureWasmLoaded();
  const classes = new Set();

  /** @type {Record<string, string[]>} */
  const byExt = {};
  for (const entry of dirs) {
    let files;
    try {
      files = await fs.getFilesFromDirectory(entry);
    } catch {
      continue;
    }
    for (const [filePath, content] of Object.entries(files)) {
      const dot = filePath.lastIndexOf('.');
      if (dot === -1) continue;
      const ext = filePath.slice(dot + 1);
      if (extensions && extensions.length > 0 && !extensions.includes(ext)) continue;
      (byExt[ext] ||= []).push(content);
    }
  }

  for (const [ext, contents] of Object.entries(byExt)) {
    const results = await /** @type {Function} */ (_getTailwindClasses)({ content: contents.join('\n'), extension: ext });
    for (const r of results) {
      classes.add(r);
    }
  }

  return [...classes];
}

export default class TailwindPlugin extends Plugin {
  get name() { return 'tailwind' }
  get commands() {
    return [
      {
        name: 'tailwind',
        aliases: ['tw'],
        description: 'Generate Tailwind CSS using compile() API with WasmScanner',
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
    ];
  }

  /** @param {import('../plugin.mjs').InitContext} ctx */
  async init({ fs, pm, terminal: term }) {
    const config = await readJSON(fs, 'tailwind.config.json');
    if (!config) return;
    const dirs = config.content || [];
    if (dirs.length === 0) return;
    const extensions = config.extensions && config.extensions.length > 0 ? config.extensions : DEFAULT_EXTENSIONS;

    const watchedDirs = new Set();
    /** @type {string[]} */
    const resolvedDirs = [];
    for (const entry of dirs) {
      const dir = await watchDir(fs, entry);
      if (dir && !watchedDirs.has(dir)) {
        watchedDirs.add(dir);
        resolvedDirs.push(dir);
      }
    }
    if (resolvedDirs.length === 0) return;

    const cache = createCompilerCache(config, fs);

    async function rebuild() {
      try {
      const c = await cache.getOrCreateCompiler();
      const dirs = config.content || ['.'];
      const classes = await extractClasses(fs, dirs, extensions);
        const result = c.build(classes);
        const outfile = config.outfile || './dist/tailwind.css';
        const dir = dirname(outfile);
        if (dir) {
          try { await fs.mkdir(dir, { recursive: true }); } catch {}
        }
        await fs.writeFile(outfile, result);
        term.info(`tailwind: rebuilt ${outfile} (${result.length} bytes, ${classes.length} classes)`);
        pm.emit('build:complete', { files: [{ path: outfile }], builder: 'tailwind' });
      } catch (e) {
        term.error(`tailwind rebuild failed: ${e.message}`);
      }
    }

    const unsub = pm.on('fs:change', (/** @type {{ path: string, type: string }} */ { path, type }) => {
      if (type !== 'modified' && type !== 'created') return;
      if (!resolvedDirs.some(dir => path.startsWith(dir))) return;
      if (extensions) {
        const dot = path.lastIndexOf('.');
        if (dot === -1) return;
        if (!extensions.includes(path.slice(dot + 1))) return;
      }
      rebuild();
    });

    await rebuild();
    return unsub;
  }
}

/**
 * @param {any} config
 * @param {import('../fs.mjs').WebFileSystem} fs
 */
function createCompilerCache(config, fs) {
  /** @type {any} */
  let compiler = null;
  /** @type {string | null} */
  let lastCSSInput = null;
  return {
    async getOrCreateCompiler() {
      const cssInput = buildCSSInput(config);
      if (compiler && cssInput === lastCSSInput) return compiler;
      const compile = await getCompile();
      const ls = createLoadStylesheet(fs);
      const lm = createLoadModule(fs);
      compiler = await /** @type {Function} */ (compile)(cssInput, { base: '/', loadStylesheet: ls, loadModule: lm });
      lastCSSInput = cssInput;
      return compiler;
    },
    invalidateCache() { lastCSSInput = null; },
  };
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} path
 * @returns {Promise<string | null>}
 */
export async function watchDir(fs, path) {
  try {
    const stat = await fs.stat(path);
    if (stat.isDirectory) return path;
    return dirname(path) || '.';
  } catch {
    return null;
  }
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string[]} entries
 * @param {string[]} extensions
 * @returns {Promise<string>}
 */
export async function collectContent(fs, entries, extensions) {
  await ensureWasmLoaded();
  /** @type {Record<string, string[]>} */
  const byExt = {};
  for (const entry of entries) {
    let files;
    try {
      files = await fs.getFilesFromDirectory(entry);
    } catch {
      continue;
    }
    for (const [filePath, content] of Object.entries(files)) {
      const dot = filePath.lastIndexOf('.');
      if (dot === -1) continue;
      const ext = filePath.slice(dot + 1);
      if (extensions && extensions.length > 0 && !extensions.includes(ext)) continue;
      (byExt[ext] ||= []).push(content);
    }
  }
  let all = '';
  for (const [ext, contents] of Object.entries(byExt)) {
    const results = await /** @type {Function} */ (_getTailwindClasses)({ content: contents.join('\n'), extension: ext });
    all += '\n' + results.join(' ');
  }
  return all;
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {Promise<any>}
 */
async function readConfig(fs) {
  try {
    const raw = await fs.readFile('tailwind.config.json', { encoding: 'utf8' });
    return JSON.parse(raw);
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

  term.log('Building CSS input...');
  const cssInput = buildCSSInput(config);
  const compile = await getCompile();
  const ls = createLoadStylesheet(fs);
  const lm = createLoadModule(fs);
  const compiler = await /** @type {Function} */ (compile)(cssInput, { base: '/', loadStylesheet: ls, loadModule: lm });

  term.log('Scanning content files...');
  const dirs = config.content || ['.'];
  const extensions = config.extensions && config.extensions.length > 0 ? config.extensions : DEFAULT_EXTENSIONS;
  const classes = await extractClasses(fs, dirs, extensions);
  term.info(`Found ${classes.length} unique class names`);

  term.log('Generating Tailwind CSS...');
  const result = compiler.build(classes);

  const outfile = config.outfile || './dist/tailwind.css';
  const dir = dirname(outfile);
  if (dir) {
    try { await fs.mkdir(dir, { recursive: true }); } catch {}
  }
  await fs.writeFile(outfile, result);
  term.success(`Wrote ${outfile} (${result.length} bytes, ${classes.length} classes)`);
}

/**
 * @param {string[]} args
 * @param {import('../terminal.mjs').WebTerminal} term
 * @param {import('../fs.mjs').WebFileSystem} fs
 */
async function handleWatch(args, term, fs) {
  const config = await readConfig(fs);

  const cache = createCompilerCache(config, fs);
  const extensions = config.extensions && config.extensions.length > 0 ? config.extensions : DEFAULT_EXTENSIONS;

  async function rebuild() {
    try {
      const c = await cache.getOrCreateCompiler();
      const dirs = config.content || ['.'];
      const classes = await extractClasses(fs, dirs, extensions);
      const result = c.build(classes);
      const outfile = config.outfile || './dist/tailwind.css';
      const dir = dirname(outfile);
      if (dir) {
        try { await fs.mkdir(dir, { recursive: true }); } catch {}
      }
      await fs.writeFile(outfile, result);
      term.success(`Rebuilt ${outfile} (${result.length} bytes, ${classes.length} classes)`);
    } catch (e) {
      term.error(`Rebuild failed: ${e.message}`);
    }
  }

  await rebuild();

  const watched = new Set();
  const dirs = config.content || ['.'];

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

  if (config.css && typeof config.css === 'string') {
    const cssDir = await watchDir(fs, config.css);
    if (cssDir && !watched.has(cssDir)) {
      watched.add(cssDir);
      const cssBasename = basename(config.css);
      fs.watch(cssDir, { recursive: true, debounce: 300 }, async (path, type) => {
        if (type === 'modified' && path.split('/').pop() === cssBasename) {
          cache.invalidateCache();
          term.log(`CSS config changed: ${path}`);
          await rebuild();
        }
      }).catch(() => {});
    }
  }

  term.info('Watching for changes...');
}
