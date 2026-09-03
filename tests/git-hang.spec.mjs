import { test, expect } from '@playwright/test';

// Run the REAL git add/commit through the CommandRegistry in a browser.
test('registry git add/commit completes', async ({ page }) => {
    page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

    await page.goto('http://localhost:8001/');

    const result = await page.evaluate(async () => {
        const { WebFileSystem } = await import('/src/services/fs.mjs');
        const fs = await WebFileSystem.fromOPFS('git-hang-test2');
        await fs.writeFile('hello.txt', 'hi there\n', 'utf8');
        const { CommandRegistry } = await import('/src/services/commands.mjs');
        const { registerCommands } = await import('/src/main.mjs').catch(() => ({}));
        const registry = new CommandRegistry();
        const gitCmds = Object.values(await import('/src/commands/git.mjs')).filter((c) => c?.name && c?.parser);
        const term = {
            lines: [], fs, commands: registry, prompt: 't>',
            processCommand() {},
            log(m, o) { this.lines.push([o?.class ?? '', String(m).slice(0, 80)]); },
            info(m) { this.lines.push(['log-info', String(m).slice(0, 80)]); },
            error(m) { this.lines.push(['log-error', String(m).slice(0, 80)]); },
            success(m) { this.lines.push(['log-success', String(m).slice(0, 80)]); },
        };
        for (const c of gitCmds) registry.registerCommand(c, term);

        const run = async (cmd) => {
            const t0 = performance.now();
            try {
                await Promise.race([
                    registry.processCommand(cmd, term),
                    new Promise((_, rej) => setTimeout(() => rej(new Error(cmd + ' HUNG after 30s')), 30000)),
                ]);
                term.lines.push(['meta', `${cmd} -> done in ${Math.round(performance.now() - t0)}ms`]);
            } catch (e) {
                term.lines.push(['meta', `${cmd} -> FAIL ${String(e).slice(0, 100)} (${Math.round(performance.now() - t0)}ms)`]);
            }
        };
        await run('git init');
        // No .gitignore: node_modules must be ignored by default + fast.
        await fs.mkdir('node_modules');
        await fs.writeFile('node_modules/big.js', 'x'.repeat(1000), 'utf8');
        await run('git add .');
        await run('git commit -m "F"');
        // With a .gitignore naming another dir, that dir is skipped too.
        await fs.writeFile('.gitignore', 'dist\n', 'utf8');
        await fs.mkdir('dist');
        await fs.writeFile('dist/out.js', 'x', 'utf8');
        await fs.writeFile('src2.js', 'y', 'utf8');
        await run('git add .');
        await run('git status');
        const gitLineCount = term.lines.length; // assertions below: git section only
        // --- init subcommands scaffold config files ---
        const { default: esbuildCommand } = await import('/src/commands/esbuild.mjs');
        const { default: tailwindCommand } = await import('/src/commands/tailwind.mjs');
        const { uploadCommand } = await import('/src/commands/dataverse.mjs');
        registry.registerCommand(esbuildCommand, term);
        registry.registerCommand(tailwindCommand, term);
        registry.registerCommand(uploadCommand, term);
        await run('esbuild --init');
        await run('tailwind --init');
        await run('tailwind'); // build using the scaffolded config (new keys)
        await run('upload --init');
        await run('esbuild --init'); // must refuse to overwrite
        for (const cfg of ['esbuild.config.json', 'tailwind.config.json', 'dataverse.config.json']) {
            try { term.lines.push(['meta', `${cfg}: ${(await fs.readFile(cfg, 'utf8')).slice(0, 60).replace(/\n/g, ' ')}`]); }
            catch (e) { term.lines.push(['meta', `${cfg}: MISSING ${String(e).slice(0, 60)}`]); }
        }
        return term.lines;
    });
    console.log(result.map((l) => `[${l[0]}] ${l[1]}`).join('\n'));
    expect(result.some((l) => l[1].includes('HUNG'))).toBe(false);
    // Scope git-output assertions to lines produced before the scaffold section.
    const gitSection = result.slice(0, result.findIndex((l) => l[1].includes('Wrote esbuild.config.json')));
    // node_modules never offered for staging; dist ignored via .gitignore.
    expect(gitSection.some((l) => l[1].includes('node_modules'))).toBe(false);
    expect(gitSection.some((l) => l[1].match(/\bdist\b/))).toBe(false);
    expect(gitSection.some((l) => l[1].includes('src2.js'))).toBe(true);
});
