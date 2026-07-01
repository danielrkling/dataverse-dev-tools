import { test, expect } from '@playwright/test';
import { createOptiquePlugin } from '../src/plugin.mjs';
import { object, argument, string, flag, optional } from '@optique/core';

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

test.describe('createOptiquePlugin', () => {
  let term;

  test.beforeEach(() => {
    term = new MockTerminal();
  });

  test('generates handler that parses args and calls execute', async () => {
    const plugin = createOptiquePlugin({
      name: 'test',
      commands: [
        {
          name: 'greet',
          parser: object({
            name: argument(string()),
          }),
          execute: (parsed) => `Hello, ${parsed.name}!`,
        },
      ],
    });

    const cmd = plugin.commands[0];
    const result = await cmd.handler(['world'], term, { fs: {}, pm: {} });
    expect(result).toBe('Hello, world!');
    expect(term.logs).toEqual([]);
  });

  test('does not call execute when parsing fails', async () => {
    let executed = false;
    const plugin = createOptiquePlugin({
      name: 'test',
      commands: [
        {
          name: 'need-arg',
          parser: object({
            file: argument(string()),
          }),
          execute: () => {
            executed = true;
            return 'ok';
          },
        },
      ],
    });

    const result = await plugin.commands[0].handler([], term, { fs: {}, pm: {} });
    expect(result).toBe('');
    expect(executed).toBe(false);
    expect(term.logs.length).toBeGreaterThan(0);
  });

  test('does not call execute when --help is shown', async () => {
    let executed = false;
    const plugin = createOptiquePlugin({
      name: 'test',
      commands: [
        {
          name: 'helpable',
          parser: object({
            path: optional(argument(string())),
          }),
          execute: () => {
            executed = true;
            return 'ok';
          },
        },
      ],
    });

    const result = await plugin.commands[0].handler(['--help'], term, { fs: {}, pm: {} });
    expect(result).toBe('');
    expect(executed).toBe(false);
    expect(term.logs[0].content).toContain('Usage: helpable');
  });

  test('forwards parseAs to parseCommandArgs for help labels', async () => {
    const plugin = createOptiquePlugin({
      name: 'test',
      commands: [
        {
          name: 'git',
          parseAs: 'git status',
          parser: object({}),
          execute: () => 'ok',
        },
      ],
    });

    await plugin.commands[0].handler(['--help'], term, { fs: {}, pm: {} });
    expect(term.logs[0].content).toContain('Usage: git status');
  });

  test('passes through init and metadata', () => {
    const init = () => {};
    const plugin = createOptiquePlugin({
      name: 'meta',
      init,
      commands: [
        {
          name: 'cmd',
          parser: object({}),
          aliases: ['c'],
          description: 'A command',
          usage: 'cmd',
          brief: 'Brief',
          execute: () => '',
        },
      ],
    });

    expect(plugin.name).toBe('meta');
    expect(plugin.init).toBe(init);
    expect(plugin.commands[0].aliases).toEqual(['c']);
    expect(plugin.commands[0].description).toBe('A command');
    expect(plugin.commands[0].usage).toBe('cmd');
  });
});
