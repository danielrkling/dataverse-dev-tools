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
 * @typedef {Object} ExecuteContext
 * @property {import('./fs.mjs').WebFileSystem} fs
 * @property {PluginManager} pm
 */

/**
 * @typedef {Object} InitContext
 * @property {import('./fs.mjs').WebFileSystem} fs
 * @property {PluginManager} pm
 * @property {import('./terminal.mjs').WebTerminal} terminal
 */

export class Plugin {
  /** @returns {string} */
  get name() { throw new Error('Plugin subclasses must override name getter') }

  /** @returns {Command[]} */
  get commands() { return [] }

  /**
   * @param {InitContext} ctx
   * @returns {void | (() => void) | Promise<(() => void) | void>}
   */
  init(ctx) {}
}

/**
 * @param {string} str
 * @param {string} pattern
 * @returns {boolean}
 */
function matchGlob(str, pattern) {
  if (pattern === '**') return true;
  const regex = '^' + pattern.replace(/([.+^${}()|[\]\\])/g, '\\$1').replace(/\*\*/g, '.*').replace(/\*/g, '[^:]*').replace(/\?/g, '.') + '$';
  return new RegExp(regex).test(str);
}

/**
 * @param {string | Record<string,string> | null} filter
 * @param {any} data
 * @returns {boolean}
 */
function matchFilter(filter, data) {
  if (typeof filter === 'string') {
    const val = data && typeof data === 'object' && 'path' in data ? data.path : data;
    if (typeof val !== 'string') return false;
    return matchGlob(val, filter);
  }
  if (typeof filter === 'object' && filter !== null) {
    for (const [key, pattern] of Object.entries(filter)) {
      const val = data && typeof data === 'object' ? data[key] : undefined;
      if (val === undefined || typeof val !== 'string') return false;
      if (!matchGlob(val, pattern)) return false;
    }
    return true;
  }
  return true;
}

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
  /** @type {Map<string, Set<{eventName: string, filter: any, callback: Function}>>} */
  #listeners = new Map();
  /** @type {Map<string, Function>} */
  #cleanups = new Map();
  /** @type {import('./terminal.mjs').WebTerminal | null} */
  #terminal = null;
  /** @type {import('./fs.mjs').WebFileSystem} */
  #fs;

  /**
   * @param {{ terminal?: import('./terminal.mjs').WebTerminal | null, fs: import('./fs.mjs').WebFileSystem }} options
   */
  constructor({ terminal, fs }) {
    if (!fs) throw new Error('PluginManager requires a WebFileSystem instance');
    this.#terminal = terminal ?? null;
    this.#fs = fs;
  }

  /** @returns {CommandRegistry} */
  get registry() {
    return this.#registry;
  }

  /** @returns {import('./terminal.mjs').WebTerminal | null} */
  get terminal() {
    return this.#terminal;
  }

  /** @returns {import('./fs.mjs').WebFileSystem} */
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

  /**
   * Subscribe to events. Accepts 2 or 3 arguments:
   *   on(eventName, callback)
   *   on(eventName, filter, callback)
   *
   * The eventName supports glob patterns (* and **).
   * The filter can be:
   *   - A glob string: matched against `data.path` (if data is an object) or `data` itself
   *   - An object of { key: globPattern }: each key's value in data is matched against the pattern
   *
   * @param {string} eventName
   * @param {((data: any, event: string) => void) | string | Record<string,string>} filterOrCallback
   * @param {(data: any, event: string) => void} [callback]
   * @returns {() => void} Unsubscribe function
   */
  on(eventName, filterOrCallback, callback) {
    let filter = null;
    /** @type {(data: any, event: string) => void} */
    let cb;

    if (typeof filterOrCallback === 'function') {
      cb = filterOrCallback;
    } else {
      filter = filterOrCallback;
      cb = /** @type {(data: any, event: string) => void} */ (callback);
      if (typeof cb !== 'function') throw new Error('on() requires a callback function');
    }

    const entry = { eventName, filter, callback: cb };
    const key = eventName + '|' + (filter ? JSON.stringify(filter) : '');
    if (!this.#listeners.has(key)) {
      this.#listeners.set(key, new Set());
    }
    const listeners = this.#listeners.get(key);
    if (listeners) listeners.add(entry);
    return () => this.off(eventName, filter, cb);
  }

  /**
   * @param {string} eventName
   * @param {((data: any, event: string) => void) | string | Record<string,string> | null} [filterOrCallback]
   * @param {(data: any, event: string) => void} [callback]
   */
  off(eventName, filterOrCallback, callback) {
    /** @type {string | Record<string, string> | null} */
    let filter = null;
    /** @type {(data: any, event: string) => void | undefined} */
    let cb;

    if (typeof filterOrCallback === 'function') {
      cb = filterOrCallback;
    } else if (filterOrCallback !== undefined) {
      filter = filterOrCallback;
      cb = callback;
    } else {
      // Remove all listeners for this event
      for (const [key] of this.#listeners) {
        if (key.startsWith(eventName + '|')) {
          this.#listeners.delete(key);
        }
      }
      return;
    }

    const key = eventName + '|' + (filter ? JSON.stringify(filter) : '');
    const set = this.#listeners.get(key);
    if (set) {
      for (const entry of set) {
        if (entry.callback === cb) {
          set.delete(entry);
          if (set.size === 0) this.#listeners.delete(key);
          break;
        }
      }
    }
  }

  /**
   * @param {string} event
   * @param {any} data
   */
  emit(event, data) {
    for (const [, entries] of this.#listeners) {
      for (const entry of entries) {
        if (!matchGlob(event, entry.eventName)) continue;
        if (entry.filter && !matchFilter(entry.filter, data)) continue;
        try { entry.callback(data, event); } catch (e) { console.error(`Event handler error for '${entry.eventName}':`, e); }
      }
    }
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
   * @param {any} module
   */
  loadPlugin(name, module) {
    const exported = module.default || module;
    const plugin = typeof exported === 'function' && exported.prototype instanceof Plugin ? new exported() : exported;
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
   * Clean up old listeners and re-run init on all plugins that have an init method.
   * Called when the file system is ready or changes.
   */
  async initPlugins() {
    for (const [name, plugin] of this.#plugins) {
      const oldCleanup = this.#cleanups.get(name);
      if (oldCleanup) {
        try { oldCleanup(); } catch (e) { console.error(`Cleanup error for '${name}':`, e); }
      }
      this.#cleanups.delete(name);
      if (typeof plugin.init === 'function') {
        try {
          const result = await plugin.init({ fs: this.#fs, pm: this, terminal: /** @type {import('./terminal.mjs').WebTerminal} */ (this.#terminal) });
          if (typeof result === 'function') {
            this.#cleanups.set(name, result);
          }
        } catch (e) {
          console.error(`Plugin '${name}' init error:`, e);
        }
      }
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

