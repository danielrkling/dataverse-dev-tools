import { Plugin } from '../plugin.mjs';

export default class BuiltinPlugin extends Plugin {
  get name() { return 'builtin' }
  get commands() {
    return [
      {
        name: 'help',
        aliases: ['?'],
        description: 'Show available commands or details about a specific command',
        usage: 'help [command]',
        /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
        handler: (args, term, { pm }) => {
          if (args.length > 0) {
            const cmd = pm.registry.resolve(args[0]);
            if (cmd) {
              const parts = [`${cmd.name} — ${cmd.description}`];
              if (cmd.usage) parts.push(`Usage: ${cmd.usage}`);
              if (cmd.aliases?.length) parts.push(`Aliases: ${cmd.aliases.join(', ')}`);
              term.log(parts.join('\n'));
              return '';
            }
            term.log(`No help found for '${args[0]}'`, { class: 'log-error' });
            return '';
          }
          const cmds = pm.registry.list();
          const lines = cmds.map(c => `  ${c.name.padEnd(15)} ${c.description}`);
          term.log(`Available commands (${cmds.length}):\n${lines.join('\n')}`);
          return '';
        },
      },
      {
        name: 'clear',
        description: 'Clear the terminal screen',
        /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term */
        handler: (args, term) => {
          term.clear();
          return '';
        },
      },
    ];
  }
}
