import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(3000);
await page.locator("file-tree .recent-item", { hasText: "Use OPFS" }).click();
await page.waitForTimeout(1500);
await page.evaluate(() => { window.prompt = () => "rename-me.txt"; });
await page.locator("file-tree #new-file").click();
await page.waitForTimeout(800);
const res = await page.evaluate(async () => {
    const treeEl = document.querySelector("file-tree");
    treeEl._tree.startRenaming("rename-me.txt");
    await new Promise(r => setTimeout(r, 600));
    const container = treeEl.shadowRoot.querySelector("file-tree-container");
    const html = container.shadowRoot.innerHTML;
    return {
        hasRenameMarker: html.includes("rename"),
        snippet: (html.match(/.{0,120}rename.{0,200}/i) || ["none"])[0],
        inputCount: (html.match(/<input|<textarea/g) || []).length,
    };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
