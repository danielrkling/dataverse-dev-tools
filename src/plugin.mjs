/**
 * @typedef {Object} Command
 * @property {string} name
 * @property {CommandHandler} handler
 * @property {string[]} [aliases]
 * @property {string} [description]
 * @property {string} [usage]
 * @property {string} [plugin]
 */

/**
 * @typedef {Object} Plugin
 * @property {string} name
 * @property {Command[]} commands
 */

/**
 * @typedef {Object} ExecuteContext
 * @property {import('./fs.mjs').WebFileSystem | null} [fs]
 * @property {PluginManager} pm
 */

/**
 * @callback CommandHandler
 * @param {string[]} args
 * @param {import('./terminal.mjs').WebTerminal} term
 * @param {ExecuteContext} context
 * @returns {any}
 */

export class CommandRegistry {
  /** @type {Map<string, Command>} */
  #commands = new Map();
  /** @type {Map<string, string>} */
  #aliases = new Map();

  /**
   * @param {Command} cmd
   */
  register({ name, handler, aliases = [], description = '', usage = '', plugin = '' }) {
    if (this.#commands.has(name)) {
      throw new Error(`Command '${name}' is already registered`);
    }
    const cmd = { name, handler, aliases, description, usage, plugin };
    this.#commands.set(name, cmd);
    for (const alias of aliases) {
      if (this.#aliases.has(alias)) {
        console.warn(`Alias '${alias}' already points to '${this.#aliases.get(alias)}', overwriting`);
      }
      this.#aliases.set(alias, name);
    }
  }

  /**
   * @param {string} name
   */
  unregister(name) {
    const cmd = this.#commands.get(name);
    if (cmd) {
      for (const alias of cmd.aliases ?? []) {
        this.#aliases.delete(alias);
      }
      this.#commands.delete(name);
    }
  }

  /**
   * @param {string} input
   * @returns {Command | null}
   */
  resolve(input) {
    return this.#commands.get(input) || this.#commands.get(this.#aliases.get(input) ?? '') || null;
  }

  /** @returns {Command[]} */
  list() {
    return [...this.#commands.values()];
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#commands.has(name) || this.#aliases.has(name);
  }
}

export class PluginManager {
  /** @type {CommandRegistry} */
  #registry = new CommandRegistry();
  /** @type {Map<string, Plugin>} */
  #plugins = new Map();
  /** @type {import('./terminal.mjs').WebTerminal | null} */
  #terminal = null;
  /** @type {import('./fs.mjs').WebFileSystem | null} */
  #fs = null;

  /**
   * @param {{ terminal?: import('./terminal.mjs').WebTerminal | null, fs?: import('./fs.mjs').WebFileSystem | null }} [options]
   */
  constructor({ terminal, fs } = {}) {
    this.#terminal = terminal ?? null;
    this.#fs = fs ?? null;
    this.#registerBuiltin();
  }

  /** @returns {CommandRegistry} */
  get registry() {
    return this.#registry;
  }

  /** @returns {import('./terminal.mjs').WebTerminal | null} */
  get terminal() {
    return this.#terminal;
  }

  /** @returns {import('./fs.mjs').WebFileSystem | null} */
  get fs() {
    return this.#fs;
  }

  /**
   * @param {import('./terminal.mjs').WebTerminal} terminal
   */
  setTerminal(terminal) {
    this.#terminal = terminal;
  }

  /**
   * @param {import('./fs.mjs').WebFileSystem} fs
   */
  setFs(fs) {
    this.#fs = fs;
  }

  #registerBuiltin() {
    this.#registry.register({
      name: 'help',
      aliases: ['?'],
      description: 'Show available commands or details about a specific command',
      usage: 'help [command]',
      plugin: 'builtin',
      /** @type {CommandHandler} */
      handler: (args, term, { pm }) => {
        if (args.length > 0) {
          const cmd = pm.registry.resolve(args[0]);
          if (cmd) {
            const parts = [`${cmd.name} — ${cmd.description}`];
            if (cmd.usage) parts.push(`Usage: ${cmd.usage}`);
            if (cmd.aliases && cmd.aliases.length) parts.push(`Aliases: ${cmd.aliases.join(', ')}`);
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
    });

    this.#registry.register({
      name: 'clear',
      description: 'Clear the terminal screen',
      plugin: 'builtin',
      /** @type {CommandHandler} */
      handler: (args, term) => {
        term.clear();
        return '';
      },
    });
  }

  /**
   * @param {Plugin} plugin
   */
  registerPlugin(plugin) {
    if (this.#plugins.has(plugin.name)) {
      throw new Error(`Plugin '${plugin.name}' is already registered`);
    }
    this.#plugins.set(plugin.name, plugin);
    for (const cmd of plugin.commands) {
      this.#registry.register({ ...cmd, plugin: plugin.name });
    }
  }

  /**
   * @param {string} name
   * @param {() => Promise<{default: Plugin}>} importFn
   */
  async loadPlugin(name, importFn) {
    const module = await importFn();
    const plugin = module.default || module;
    this.registerPlugin(plugin);
  }

  /**
   * @param {string} name
   */
  unloadPlugin(name) {
    const plugin = this.#plugins.get(name);
    if (plugin) {
      for (const cmd of plugin.commands) {
        this.#registry.unregister(cmd.name);
      }
      this.#plugins.delete(name);
    }
  }

  /**
   * @param {string[]} args
   * @param {import('./terminal.mjs').WebTerminal} terminal
   * @returns {Promise<string|undefined>}
   */
  async execute(args, terminal) {
    if (args.length === 0) return;
    const cmd = this.#registry.resolve(args[0]);
    if (!cmd) {
      terminal.log(`Unknown command: ${args[0]}. Type 'help' for a list of commands.`, { class: 'log-error' });
      return;
    }
    try {
      const context = { fs: this.#fs, pm: this };
      return await cmd.handler(args.slice(1), terminal, context);
    } catch (error) {
      terminal.log(`Error executing '${cmd.name}': ${error.message}`, { class: 'log-error' });
      console.error(`PluginManager.execute error for '${cmd.name}':`, error);
      return;
    }
  }
}
