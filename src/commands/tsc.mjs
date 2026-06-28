const TS_CDN = 'https://cdn.jsdelivr.net/npm/typescript@5.7.2/lib/typescript.js';
const LIB_CDN = 'https://cdn.jsdelivr.net/npm/typescript@5.7.2/lib/';

let workerRef = null;
let workerReady = false;
let requestId = 0;

async function getWorker() {
  if (workerRef && workerReady) return workerRef;

  const workerCode = `
const TS_CDN = ${JSON.stringify(TS_CDN)};
const LIB_CDN = ${JSON.stringify(LIB_CDN)};

importScripts(TS_CDN);

const libCache = new Map();

/** All lib files needed for ES2022 target (the default). */
const ES2022_LIBS = [
  'lib.es5.d.ts',
  'lib.decorators.d.ts',
  'lib.decorators.legacy.d.ts',
  'lib.es2015.d.ts',
  'lib.es2015.collection.d.ts',
  'lib.es2015.core.d.ts',
  'lib.es2015.generator.d.ts',
  'lib.es2015.iterable.d.ts',
  'lib.es2015.promise.d.ts',
  'lib.es2015.proxy.d.ts',
  'lib.es2015.reflect.d.ts',
  'lib.es2015.symbol.d.ts',
  'lib.es2015.symbol.wellknown.d.ts',
  'lib.es2016.d.ts',
  'lib.es2016.array.include.d.ts',
  'lib.es2017.d.ts',
  'lib.es2017.date.d.ts',
  'lib.es2017.intl.d.ts',
  'lib.es2017.object.d.ts',
  'lib.es2017.sharedmemory.d.ts',
  'lib.es2017.string.d.ts',
  'lib.es2017.typedarrays.d.ts',
  'lib.es2018.d.ts',
  'lib.es2018.asyncgenerator.d.ts',
  'lib.es2018.asynciterable.d.ts',
  'lib.es2018.intl.d.ts',
  'lib.es2018.promise.d.ts',
  'lib.es2018.regexp.d.ts',
  'lib.es2019.d.ts',
  'lib.es2019.array.d.ts',
  'lib.es2019.intl.d.ts',
  'lib.es2019.object.d.ts',
  'lib.es2019.string.d.ts',
  'lib.es2019.symbol.d.ts',
  'lib.es2020.d.ts',
  'lib.es2020.bigint.d.ts',
  'lib.es2020.date.d.ts',
  'lib.es2020.intl.d.ts',
  'lib.es2020.number.d.ts',
  'lib.es2020.promise.d.ts',
  'lib.es2020.sharedmemory.d.ts',
  'lib.es2020.string.d.ts',
  'lib.es2020.symbol.wellknown.d.ts',
  'lib.es2021.d.ts',
  'lib.es2021.intl.d.ts',
  'lib.es2021.promise.d.ts',
  'lib.es2021.weakref.d.ts',
  'lib.es2021.string.d.ts',
  'lib.es2022.d.ts',
  'lib.es2022.array.d.ts',
  'lib.es2022.error.d.ts',
  'lib.es2022.intl.d.ts',
  'lib.es2022.object.d.ts',
  'lib.es2022.sharedmemory.d.ts',
  'lib.es2022.string.d.ts',
  'lib.es2022.regexp.d.ts',
];

async function initLibs() {
  const results = await Promise.allSettled(
    ES2022_LIBS.map(async (name) => {
      const resp = await fetch(LIB_CDN + name);
      if (!resp.ok) throw new Error('Failed to fetch ' + name + ': ' + resp.status);
      libCache.set('/' + name, await resp.text());
    })
  );
  for (const r of results) {
    if (r.status === 'rejected') console.error('[tsc] lib fetch:', r.reason);
  }
}

self.onmessage = async (e) => {
  const { id, type, data } = e.data;

  try {
    if (type === 'init') {
      await initLibs();
      if (libCache.size === 0) {
        self.postMessage({ id, type: 'error', error: 'Failed to load any TypeScript standard library files from CDN. Check network connectivity.' });
        return;
      }
      self.postMessage({ id, type: 'ready' });
    }

    if (type === 'check') {
      const { files, tsconfig } = data;

      const rawOpts = tsconfig?.compilerOptions || {};

      const libName = rawOpts.lib?.[0]
        ? 'lib.' + rawOpts.lib[0].toLowerCase() + '.d.ts'
        : 'lib.es2022.d.ts';

      const compilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        lib: [libName.replace(/^lib\./, '').replace(/\.d\.ts$/, '')],
        ...rawOpts,
        noEmit: true,
      };

      const allFiles = new Map(Object.entries(files));

      // Seed allFiles with lib cache so fileExists/getSourceFile find them
      for (const [k, v] of libCache) {
        if (!allFiles.has(k)) allFiles.set(k, v);
      }

      const rootNames = Object.keys(files).filter(f =>
        f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mts')
      );

      if (allFiles.size === 0) {
        self.postMessage({ id, type: 'error', error: 'No files to check' });
        return;
      }

      const program = ts.createProgram({
        rootNames,
        options: compilerOptions,
        host: {
          getSourceFile(fileName, languageVersion) {
            const content = allFiles.get(fileName);
            if (content === undefined) {
              // Try lowercase key (case-insensitive fallback)
              const lower = fileName.toLowerCase();
              for (const [k, v] of allFiles) {
                if (k.toLowerCase() === lower) return ts.createSourceFile(fileName, v, languageVersion);
              }
              return undefined;
            }
            return ts.createSourceFile(fileName, content, languageVersion);
          },
          getDefaultLibFileName() { return '/lib.d.ts'; },
          writeFile() {},
          getCurrentDirectory() { return '/'; },
          getCanonicalFileName(f) { return f; },
          useCaseSensitiveFileNames() { return true; },
          getNewLine() { return '\\n'; },
          fileExists(fileName) {
            if (allFiles.has(fileName)) return true;
            const lower = fileName.toLowerCase();
            for (const k of allFiles.keys()) {
              if (k.toLowerCase() === lower) return true;
            }
            return false;
          },
          readFile(fileName) {
            let c = allFiles.get(fileName);
            if (c !== undefined) return c;
            const lower = fileName.toLowerCase();
            for (const [k, v] of allFiles) {
              if (k.toLowerCase() === lower) return v;
            }
            return undefined;
          },
          readDirectory(path, extensions, exclude, include, depth) {
            const names = [...allFiles.keys()].filter(f => f.startsWith(path));
            return names;
          },
          getDirectories() { return []; },
        },
      });

      const diagnostics = [
        ...program.getSyntacticDiagnostics(),
        ...program.getSemanticDiagnostics(),
        ...program.getDeclarationDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getOptionsDiagnostics(),
      ];

      const result = [];
      for (const d of diagnostics) {
        let file = '';
        let line = 0;
        let col = 0;
        if (d.file && d.start != null) {
          const pos = d.file.getLineAndCharacterOfPosition(d.start);
          file = d.file.fileName;
          line = pos.line + 1;
          col = pos.character + 1;
        }
        const message = ts.flattenDiagnosticMessageText(d.messageText, '\\n');
        const severity = d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning';
        result.push({ file, line, col, message, severity, code: d.code });
      }

      self.postMessage({ id, type: 'result', data: { diagnostics: result } });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: err.message + '\\n' + (err.stack || '') });
  }
};
  `;

  const blob = new Blob([workerCode], { type: 'application/javascript' });
  workerRef = new Worker(URL.createObjectURL(blob));
  workerReady = false;

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('tsc worker initialization timed out')), 120000);

    workerRef.addEventListener('message', function handler(e) {
      if (e.data.id === id) {
        clearTimeout(timeout);
        workerRef.removeEventListener('message', handler);
        if (e.data.type === 'ready') {
          workerReady = true;
          resolve(workerRef);
        } else if (e.data.type === 'error') {
          reject(new Error(e.data.error));
        }
      }
    });

    workerRef.postMessage({ id, type: 'init' });
  });
}

async function runCheck(fs) {
  await getWorker();

  const files = {};

  let tsconfigRaw;
  let tsconfig = null;
  try {
    tsconfigRaw = await fs.readFile('tsconfig.json', { encoding: 'utf8' });
    tsconfig = JSON.parse(typeof tsconfigRaw === 'string' ? tsconfigRaw : new TextDecoder().decode(tsconfigRaw));
  } catch {}

  const excludedDirs = new Set(tsconfig?.exclude || ['node_modules', 'dist', '.git']);
  const scanDirs = tsconfig?.include || ['.'];

  for (const dir of scanDirs) {
    try {
      const dirFiles = await fs.getFilesFromDirectory(dir);
      for (const [path, content] of Object.entries(dirFiles)) {
        const topDir = path.split('/')[0];
        if (excludedDirs.has(topDir)) continue;
        if (!path.endsWith('.ts') && !path.endsWith('.tsx') && !path.endsWith('.mts')) continue;
        const fullPath = path.startsWith('/') ? path : '/' + path;
        files[fullPath] = typeof content === 'string' ? content : new TextDecoder().decode(content);
      }
    } catch {}
  }

  const tsconfigForWorker = tsconfig ? structuredClone(tsconfig) : null;
  if (tsconfigForWorker) {
    delete tsconfigForWorker.include;
    delete tsconfigForWorker.exclude;
    delete tsconfigForWorker.files;
    delete tsconfigForWorker.references;
  }

  const id = ++requestId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Type check timed out')), 120000);

    workerRef.addEventListener('message', function handler(e) {
      if (e.data.id === id) {
        clearTimeout(timeout);
        workerRef.removeEventListener('message', handler);
        if (e.data.type === 'result') {
          resolve(e.data.data);
        } else if (e.data.type === 'error') {
          reject(new Error(e.data.error));
        }
      }
    });

    workerRef.postMessage({ id, type: 'check', data: { files, tsconfig: tsconfigForWorker } });
  });
}

/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'tsc',
  commands: [
    {
      name: 'tsc',
      aliases: ['typecheck', 'tc'],
      description: 'Type-check TypeScript files',
      usage: 'tsc',
      handler: async (args, term, { fs }) => {
        term.log('Loading TypeScript compiler...');
        try {
          const result = await runCheck(fs);
          const diags = result?.diagnostics || [];
          const errors = diags.filter(d => d.severity === 'error');
          const warnings = diags.filter(d => d.severity !== 'error');

          if (diags.length === 0) {
            term.success('No type errors found.');
            return '';
          }

          for (const d of diags) {
            const loc = d.file ? d.file + (d.line != null ? ':' + d.line + ':' + (d.col || 1) : '') : '';
            const icon = d.severity === 'error' ? '✖' : '⚠';
            term.log(icon + ' ' + loc + '  ' + d.message + '  (TS' + d.code + ')');
          }

          if (errors.length > 0) {
            term.error('Found ' + errors.length + ' error(s), ' + warnings.length + ' warning(s)');
          } else {
            term.success(warnings.length + ' warning(s) found');
          }
          return '';
        } catch (e) {
          return 'tsc failed: ' + e.message;
        }
      },
    },
  ],
};
