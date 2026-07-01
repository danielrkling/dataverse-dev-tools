import { test, expect } from '@playwright/test';
import { parseCommandArgs } from '../src/utils/args.mjs';
import { object, argument, string, flag, optional, option } from '@optique/core';

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

test.describe('parseCommandArgs', () => {
  let term;

  test.beforeEach(() => {
    term = new MockTerminal();
  });

  test('parses correct options and positional arguments', () => {
    const parser = object({
      publish: flag('--publish'),
      path: argument(string()),
    });

    const result = parseCommandArgs(parser, 'test', ['src/', '--publish'], term);
    expect(result).toEqual({ publish: true, path: 'src/' });
    expect(term.logs).toEqual([]);
  });

  test('handles missing required argument', () => {
    const parser = object({
      file: argument(string()),
    });

    const result = parseCommandArgs(parser, 'test', [], term);
    expect(result).toBeNull();
    expect(term.logs.length).toBeGreaterThan(0);
    expect(term.logs.some(log => log.content.includes('Missing required argument'))).toBe(true);
  });

  test('handles unexpected options', () => {
    const parser = object({
      file: argument(string()),
    });

    const result = parseCommandArgs(parser, 'test', ['file.txt', '--extra'], term);
    expect(result).toBeNull();
    expect(term.logs.length).toBeGreaterThan(0);
    expect(term.logs.some(log => log.content.includes('Unexpected option or argument'))).toBe(true);
  });

  test('handles --help flag', () => {
    const parser = object({
      path: optional(argument(string())),
    });

    const result = parseCommandArgs(parser, 'test', ['--help'], term);
    expect(result).toBeNull();
    expect(term.logs.length).toBeGreaterThan(0);
    expect(term.logs[0].content).toContain('Usage: test');
  });
});
