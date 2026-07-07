import { test, expect } from '@playwright/test';
import { esbuildConfigSchema, dataverseConfigSchema, tailwindConfigSchema } from '../src/utils/schemas.mjs';

function stripEmpty(v) {
  if (v === undefined) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

test.describe('esbuild two-pass config merge', () => {
  test('CLI overrides file config', () => {
    const fileConfig = { entryPoints: ['./src/app.ts'], outdir: 'dist', format: 'esm', minify: false };
    const validatedConfig = esbuildConfigSchema.parse(fileConfig);
    const cliFields = { minify: true };
    const merged = esbuildConfigSchema.parse({ ...validatedConfig, ...cliFields });
    expect(merged.minify).toBe(true);
    expect(merged.entryPoints).toEqual(['./src/app.ts']);
    expect(merged.outdir).toBe('dist');
  });

  test('CLI undefined does not override file config defaults', () => {
    const fileConfig = { entryPoints: ['./src/app.ts'], outdir: 'dist' };
    const validatedConfig = esbuildConfigSchema.parse(fileConfig);
    const cliFields = { outdir: undefined, minify: undefined, bundle: undefined };
    const merged = esbuildConfigSchema.parse({ ...validatedConfig, ...Object.fromEntries(Object.entries(cliFields).filter(([_, v]) => !stripEmpty(v))) });
    expect(merged.outdir).toBe('dist');
    expect(merged.minify).toBe(false);
    expect(merged.bundle).toBe(true);
  });

  test('CLI empty positional entryPoints do not clobber config entryPoints', () => {
    const fileConfig = { entryPoints: ['./src/app.ts'] };
    const validatedConfig = esbuildConfigSchema.parse(fileConfig);
    const cliFields = { entryPoints: [] };
    const merged = esbuildConfigSchema.parse({ ...validatedConfig, ...Object.fromEntries(Object.entries(cliFields).filter(([_, v]) => !stripEmpty(v))) });
    expect(merged.entryPoints).toEqual(['./src/app.ts']);
  });

  test('CLI provides entryPoints overrides config', () => {
    const fileConfig = { entryPoints: ['./src/app.ts'] };
    const validatedConfig = esbuildConfigSchema.parse(fileConfig);
    const cliFields = { entryPoints: ['./src/main.ts'] };
    const merged = esbuildConfigSchema.parse({ ...validatedConfig, ...cliFields });
    expect(merged.entryPoints).toEqual(['./src/main.ts']);
  });

  test('unset optional fields remain undefined', () => {
    const merged = esbuildConfigSchema.parse({});
    expect(merged.tsconfig).toBeUndefined();
    expect(merged.globalName).toBeUndefined();
    expect(merged.outfile).toBeUndefined();
  });
});

test.describe('esbuild CLI parser transformations', () => {
  test('mainFields CLI pattern matches schema', () => {
    const cliValue = 'browser,module,main';
    const transformed = cliValue.split(',').map(s => s.trim());
    const result = esbuildConfigSchema.safeParse({ mainFields: transformed });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mainFields).toEqual(['browser', 'module', 'main']);
  });

  test('treeShaking CLI true maps to boolean', () => {
    const result = esbuildConfigSchema.safeParse({ treeShaking: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.treeShaking).toBe(true);
  });
});

test.describe('dataverse two-pass config merge', () => {
  test('CLI prefix overrides config', () => {
    const fileConfig = { prefix: 'old_prefix_' };
    const validatedConfig = dataverseConfigSchema.parse(fileConfig);
    const cliFields = { prefix: 'new_prefix_' };
    const merged = dataverseConfigSchema.parse({ ...validatedConfig, ...cliFields });
    expect(merged.prefix).toBe('new_prefix_');
    expect(merged.solution).toBeUndefined();
  });

  test('CLI empty does not override config defaults', () => {
    const fileConfig = { prefix: 'myapp_' };
    const validatedConfig = dataverseConfigSchema.parse(fileConfig);
    const cliFields = { prefix: undefined, solution: undefined };
    const merged = dataverseConfigSchema.parse({ ...validatedConfig, ...Object.fromEntries(Object.entries(cliFields).filter(([_, v]) => !stripEmpty(v))) });
    expect(merged.prefix).toBe('myapp_');
    expect(merged.solution).toBeUndefined();
  });
});

test.describe('tailwind two-pass config merge', () => {
  test('CLI outfile overrides config', () => {
    const config = tailwindConfigSchema.parse({});
    const cliFields = { outfile: './custom/out.css' };
    const merged = tailwindConfigSchema.parse({ ...config, ...cliFields });
    expect(merged.outfile).toBe('./custom/out.css');
  });

  test('CLI css overrides config', () => {
    const config = tailwindConfigSchema.parse({ css: ['@import "tailwindcss"'] });
    const cliFields = { css: ['./src/custom.css'] };
    const merged = tailwindConfigSchema.parse({ ...config, ...cliFields });
    expect(merged.css).toEqual(['./src/custom.css']);
  });

  test('CLI empty does not override config defaults', () => {
    const config = tailwindConfigSchema.parse({ outfile: './dist/app.css' });
    const cliFields = { outfile: undefined, css: undefined };
    const merged = tailwindConfigSchema.parse({ ...config, ...Object.fromEntries(Object.entries(cliFields).filter(([_, v]) => !stripEmpty(v))) });
    expect(merged.outfile).toBe('./dist/app.css');
  });
});
