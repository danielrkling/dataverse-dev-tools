import { Plugin } from '../plugin.mjs';

const EXT_TO_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx', '.jsx': 'jsx',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.json': 'json',
  '.xml': 'xml', '.svg': 'xml',
  '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml',
  '.sh': 'bash', '.bash': 'bash',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.sql': 'sql', '.env': 'env',
};

function extname(path) {
  const i = path.lastIndexOf('.');
  if (i === -1) return '';
  if (path.lastIndexOf('/') > i) return '';
  return path.slice(i);
}

export default class FlattenPlugin extends Plugin {
  get name() { return 'flatten' }
  get commands() { return [
    {
      name: 'flatten',
      aliases: ['fl'],
      description: 'Combine files into one markdown file for LLM context',
      usage: 'flatten <path> [--out <file>]',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        const outIndex = args.indexOf('--out');
        const cliOut = outIndex !== -1 && args[outIndex + 1] ? args[outIndex + 1] : null;
        const path = args.find(a => !a.startsWith('--'));

        if (!path) return 'Usage: flatten <path> [--out <file>]';

        let files;
        let dir = path;
        try {
          const stat = await fs.stat(path);
          if (stat.isDirectory) {
            const entries = await fs.getFilesFromDirectory(path);
            files = Object.keys(entries).sort();
          } else {
            files = [path];
            dir = path.split('/').slice(0, -1).join('/') || '.';
          }
        } catch {
          return `flatten: cannot read '${path}'`;
        }

        const folderName = dir === '.' ? 'project' : dir.split('/').filter(Boolean).pop() || 'project';
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const outFile = cliOut || `${dir}/${folderName}_${ts}.md`;
        const lines = [`# Project Files`, `Generated: ${timestamp}`, '', ''];

        for (const file of files) {
          try {
            const content = await fs.readFile(file, { encoding: 'utf8' });
            let mtime = '';
            try {
              const st = await fs.stat(file);
              if (st.modifiedAt) mtime = st.modifiedAt;
            } catch {}

            lines.push(`## File: ${file}`);
            if (mtime) lines.push(`Last modified: ${mtime}`);
            lines.push('');

            const ext = extname(file);
            const lang = EXT_TO_LANG[ext] || '';
            lines.push('```' + lang);
            lines.push(typeof content === 'string' ? content : new TextDecoder().decode(content));
            lines.push('```');
            lines.push('');
          } catch {}
        }

        const result = lines.join('\n');

        if (outFile) {
          await fs.mkdir(outFile.split('/').slice(0, -1).join('/') || '.', { recursive: true }).catch(() => {});
          await fs.writeFile(outFile, result);
          return `Wrote ${outFile} (${result.length} bytes)`;
        }

        term.log(result);
        return '';
      },
    },
    ];
  }
}
