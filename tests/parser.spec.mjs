import { test, expect } from '@playwright/test';
import { parseCommandWithQuotes } from '../src/parser.mjs';

test.describe('parseCommandWithQuotes', () => {
  test('parses simple space-separated arguments', () => {
    expect(parseCommandWithQuotes('ls -la .')).toEqual(['ls', '-la', '.']);
  });

  test('parses double-quoted argument as single token', () => {
    expect(parseCommandWithQuotes('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  test('parses single-quoted argument as single token', () => {
    expect(parseCommandWithQuotes("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  test('handles mixed quoting', () => {
    expect(parseCommandWithQuotes('npm install "my package" --save')).toEqual([
      'npm',
      'install',
      'my package',
      '--save',
    ]);
  });

  test('handles empty string', () => {
    expect(parseCommandWithQuotes('')).toEqual([]);
  });

  test('handles only whitespace', () => {
    expect(parseCommandWithQuotes('   ')).toEqual([]);
  });

  test('collapses multiple spaces', () => {
    expect(parseCommandWithQuotes('cmd    arg1     arg2')).toEqual(['cmd', 'arg1', 'arg2']);
  });

  test('handles trailing content after quoted section', () => {
    expect(parseCommandWithQuotes("echo 'hello' world")).toEqual(['echo', 'hello', 'world']);
  });

  test('handles consecutive quoted sections', () => {
    expect(parseCommandWithQuotes('cmd "a b" "c d"')).toEqual(['cmd', 'a b', 'c d']);
  });

  test('handles empty quoted string', () => {
    const result = parseCommandWithQuotes('cmd ""');
    // The empty quoted string results in an empty arg being pushed
    expect(result[0]).toBe('cmd');
    expect(result).toContain('');
  });
});
