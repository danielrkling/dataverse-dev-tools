/**
 * Parse CLI args into flags, values, and positional args.
 *
 * All `--flag` are boolean by default. Use `spec.string` for flags that
 * consume the next argument as a value. Use `--flag=value` for explicit values.
 * `--` stops flag parsing; everything after is positional.
 *
 * @example
 * parseArgs(['file.ts', '--publish'])
 * // => { flags: { publish: true }, values: {}, positional: ['file.ts'] }
 *
 * @example
 * parseArgs(['--out', 'out.md', 'path'], { string: ['out'] })
 * // => { flags: {}, values: { out: 'out.md' }, positional: ['path'] }
 *
 * @example
 * parseArgs(['--define=KEY=val'])
 * // => { flags: {}, values: { define: 'KEY=val' }, positional: [] }
 *
 * @example
 * parseArgs(['-m', 'msg'], { string: ['m'] })
 * // => { flags: {}, values: { m: 'msg' }, positional: [] }
 *
 * @example
 * parseArgs(['--', '--file'])
 * // => { flags: {}, values: {}, positional: ['--file'] }
 *
 * @param {string[]} args
 * @param {{ string?: string[] }} [spec] - Flag names that take a value argument
 * @returns {{ flags: Record<string, boolean>, values: Record<string, string>, positional: string[] }}
 */
export function parseArgs(args, spec = {}) {
  const stringFlags = new Set(spec.string ?? []);
  /** @type {Record<string, boolean>} */
  const flags = {};
  /** @type {Record<string, string>} */
  const values = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') { positional.push(arg); continue; }
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }

    const isLong = arg[1] === '-';
    const prefix = isLong ? 2 : 1;
    const eq = arg.indexOf('=');

    if (eq !== -1) {
      values[arg.slice(prefix, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(prefix);
      if (stringFlags.has(key) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
        values[key] = args[++i];
      } else {
        flags[key] = true;
      }
    }
  }

  return { flags, values, positional };
}
