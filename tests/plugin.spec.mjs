import { test, expect } from '@playwright/test';
import { CommandRegistry, PluginManager } from '../src/plugin.mjs';
import builtinPlugin from '../src/commands/builtin.mjs';

class MockTerminal {
  constructor() {
    this.logs = [];
  }
  log(content, attributes) {
    this.logs.push({ content, attributes });
  }
  clear() {
    this.logs = [];
  }
}

test.describe('CommandRegistry', () => {
  let registry;

  test.beforeEach(() => {
    registry = new CommandRegistry();
  });

  test('registers and resolves a command by name', () => {
    const handler = () => 'ok';
    registry.register({ name: 'test', handler, description: 'A test command' });
    const cmd = registry.resolve('test');
    expect(cmd).not.toBeNull();
    expect(cmd.name).toBe('test');
    expect(cmd.handler).toBe(handler);
    expect(cmd.description).toBe('A test command');
  });

  test('resolves a command by alias', () => {
    registry.register({ name: 'list', aliases: ['ls', 'dir'], handler: () => 'ok' });
    expect(registry.resolve('list')).not.toBeNull();
    expect(registry.resolve('ls')).not.toBeNull();
    expect(registry.resolve('dir')).not.toBeNull();
  });

  test('returns null for unknown command', () => {
    expect(registry.resolve('nope')).toBeNull();
  });

  test('unregisters a command and its aliases', () => {
    registry.register({ name: 'test', aliases: ['t'], handler: () => 'ok' });
    registry.unregister('test');
    expect(registry.resolve('test')).toBeNull();
    expect(registry.resolve('t')).toBeNull();
  });

  test('lists all registered commands', () => {
    registry.register({ name: 'a', handler: () => {} });
    registry.register({ name: 'b', handler: () => {} });
    expect(registry.list()).toHaveLength(2);
  });

  test('throws when registering a duplicate command name', () => {
    registry.register({ name: 'dup', handler: () => {} });
    expect(() => registry.register({ name: 'dup', handler: () => {} })).toThrow();
  });

  test('has() returns true for name and alias', () => {
    registry.register({ name: 'test', aliases: ['t'], handler: () => {} });
    expect(registry.has('test')).toBe(true);
    expect(registry.has('t')).toBe(true);
    expect(registry.has('nope')).toBe(false);
  });
});

const dummyFs = /** @type {import('../src/fs.mjs').WebFileSystem} */ ({});

test.describe('PluginManager', () => {
  let pm;
  let term;

  test.beforeEach(() => {
    term = new MockTerminal();
    pm = new PluginManager({ terminal: term, fs: dummyFs });
    pm.registerPlugin(new builtinPlugin());
  });

  test('registers builtin commands on construction', () => {
    expect(pm.registry.has('help')).toBe(true);
    expect(pm.registry.has('clear')).toBe(true);
    expect(pm.registry.has('?')).toBe(true);
  });

  test('builtin help lists commands', async () => {
    await pm.execute(['help'], term);
    const lastLog = term.logs[term.logs.length - 1];
    expect(lastLog.content).toContain('Available commands');
    expect(lastLog.content).toContain('help');
    expect(lastLog.content).toContain('clear');
  });

  test('builtin help shows command details', async () => {
    await pm.execute(['help', 'clear'], term);
    const lastLog = term.logs[term.logs.length - 1];
    expect(lastLog.content).toContain('clear');
  });

  test('builtin clear clears the terminal', async () => {
    term.log('something');
    expect(term.logs.length).toBeGreaterThan(0);
    await pm.execute(['clear'], term);
    expect(term.logs.length).toBe(0);
  });

  test('registers a plugin and its commands', () => {
    const plugin = {
      name: 'test-plugin',
      commands: [
        { name: 'hello', description: 'Says hello', handler: () => 'hi' },
        { name: 'bye', description: 'Says bye', handler: () => 'bye' },
      ],
    };
    pm.registerPlugin(plugin);
    expect(pm.registry.has('hello')).toBe(true);
    expect(pm.registry.has('bye')).toBe(true);
  });

  test('unloads a plugin and removes its commands', () => {
    const plugin = {
      name: 'test-plugin',
      commands: [{ name: 'hello', handler: () => 'hi' }],
    };
    pm.registerPlugin(plugin);
    expect(pm.registry.has('hello')).toBe(true);
    pm.unloadPlugin('test-plugin');
    expect(pm.registry.has('hello')).toBe(false);
  });

  test('execute runs a command handler with context', async () => {
    pm.setFs(dummyFs);
    const plugin = {
      name: 'test-plugin',
      commands: [
        {
          name: 'ctx',
          handler: (args, term, context) => `fs=${!!context.fs}, pm=${!!context.pm}`,
        },
      ],
    };
    pm.registerPlugin(plugin);
    const result = await pm.execute(['ctx'], term);
    expect(result).toBe('fs=true, pm=true');
  });

  test('execute reports unknown command', async () => {
    await pm.execute(['nonexistent'], term);
    const lastLog = term.logs[term.logs.length - 1];
    expect(lastLog.attributes.class).toBe('log-error');
    expect(lastLog.content).toContain('Unknown command');
  });

  test('execute passes sliced args to handler', async () => {
    const plugin = {
      name: 'test-plugin',
      commands: [
        {
          name: 'echo',
          handler: (args) => args.join('|'),
        },
      ],
    };
    pm.registerPlugin(plugin);
    const result = await pm.execute(['echo', 'a', 'b', 'c'], term);
    expect(result).toBe('a|b|c');
  });
});
