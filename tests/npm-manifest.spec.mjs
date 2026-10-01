import { test, expect } from '@playwright/test';

// Brake: `npm i <pkg>` on a workspace without package.json must create one.
test('npm i creates package.json when missing', async ({ page }) => {
  page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const { WebFileSystem } = await import('/src/services/fs.mjs');
    const fs = await WebFileSystem.fromOPFS('npmi-missing-manifest');
    const { CommandRegistry } = await import('/src/services/commands.mjs');
    const { npmCommand } = await import('/src/commands/npm.mjs');
    const registry = new CommandRegistry();
    const term = {
      lines: [], fs, commands: registry, prompt: 't>',
      processCommand() {},
      log(m, o) { this.lines.push([o?.class ?? '', String(m).slice(0, 120)]); },
      info(m) { this.lines.push(['log-info', String(m).slice(0, 120)]); },
      error(m) { this.lines.push(['log-error', String(m).slice(0, 120)]); },
      success(m) { this.lines.push(['log-success', String(m).slice(0, 120)]); },
    };
    registry.registerCommand(npmCommand, term);
    await registry.processCommand('npm i ms@2.1.3', term).catch((e) => term.lines.push(['err', String(e).slice(0, 120)]));
    const exists = await fs.exists('package.json');
    let contents = null;
    if (exists) {
      contents = (await fs.readFile('package.json', { encoding: 'utf8' })).slice(0, 300);
    }
    return { exists, contents, before: term.lines };
  });
  console.log('BEFORE-LINES:', result.before.map((l) => `[${l[0]}] ${l[1]}`).join('\n'));
  console.log('PKG:', result.exists ? result.contents : 'MISSING');
  expect(result.exists).toBe(true);
  expect(result.contents).toContain('"dependencies"');
});
