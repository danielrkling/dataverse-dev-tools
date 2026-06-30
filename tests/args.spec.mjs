import { test, expect } from '@playwright/test';
import { parseArgs } from '../src/utils/args.mjs';

test.describe('parseArgs', () => {
  test('parses boolean flags', () => {
    const { flags, values, positional } = parseArgs(['--verbose', '--publish']);
    expect(flags).toEqual({ verbose: true, publish: true });
    expect(values).toEqual({});
    expect(positional).toEqual([]);
  });

  test('parses value flags with spec', () => {
    const { flags, values, positional } = parseArgs(['--out', 'dist'], { string: ['out'] });
    expect(flags).toEqual({});
    expect(values).toEqual({ out: 'dist' });
    expect(positional).toEqual([]);
  });

  test('parses --flag=value syntax', () => {
    const { flags, values, positional } = parseArgs(['--define=KEY=val']);
    expect(flags).toEqual({});
    expect(values).toEqual({ define: 'KEY=val' });
    expect(positional).toEqual([]);
  });

  test('parses short flags with value', () => {
    const { flags, values, positional } = parseArgs(['-m', 'commit message'], { string: ['m'] });
    expect(flags).toEqual({});
    expect(values).toEqual({ m: 'commit message' });
    expect(positional).toEqual([]);
  });

  test('stops parsing after -- separator', () => {
    const { flags, values, positional } = parseArgs(['--flag', '--', '--other', 'pos']);
    expect(flags).toEqual({ flag: true });
    expect(values).toEqual({});
    expect(positional).toEqual(['--other', 'pos']);
  });

  test('returns positional args', () => {
    const { flags, values, positional } = parseArgs(['file.ts', '--publish']);
    expect(flags).toEqual({ publish: true });
    expect(values).toEqual({});
    expect(positional).toEqual(['file.ts']);
  });

  test('handles mixed flags and positional args', () => {
    const { flags, values, positional } = parseArgs(['build', '--watch', 'src/']);
    expect(flags).toEqual({ watch: true });
    expect(values).toEqual({});
    expect(positional).toEqual(['build', 'src/']);
  });

  test('short flag -r as boolean', () => {
    const { flags, values, positional } = parseArgs(['-r', 'some/path']);
    expect(flags).toEqual({ r: true });
    expect(values).toEqual({});
    expect(positional).toEqual(['some/path']);
  });

  test('handles empty args', () => {
    const { flags, values, positional } = parseArgs([]);
    expect(flags).toEqual({});
    expect(values).toEqual({});
    expect(positional).toEqual([]);
  });

  test('value flag without following arg does not consume next flag', () => {
    const { flags, values, positional } = parseArgs(['--out', '--verbose'], { string: ['out'] });
    expect(values).toEqual({});
    expect(flags).toEqual({ out: true, verbose: true });
  });

  test('handles only dash as positional', () => {
    const { flags, values, positional } = parseArgs(['-']);
    expect(flags).toEqual({});
    expect(values).toEqual({});
    expect(positional).toEqual(['-']);
  });

  test('handles multiple value flags', () => {
    const { flags, values, positional } = parseArgs(
      ['--name', 'test', '--path', '/a/b', 'file'],
      { string: ['name', 'path'] },
    );
    expect(values).toEqual({ name: 'test', path: '/a/b' });
    expect(positional).toEqual(['file']);
  });
});
