import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto("http://localhost:5199/");
await page.waitForTimeout(3000);
const title = () => page.evaluate(() => document.querySelector("file-tree").shadowRoot.querySelector("#title").textContent);
const showRecents = () => page.evaluate(() => document.querySelector("file-tree").showRecentFolders());

await page.evaluate(() => { window.prompt = () => "alpha"; });
await page.locator("file-tree .recent-item", { hasText: "Use OPFS" }).click();
await page.waitForTimeout(1200);
console.log("title:", await title());

await showRecents();
await page.waitForTimeout(300);
await page.evaluate(() => { window.prompt = () => "beta"; });
await page.locator("file-tree .recent-item", { hasText: "Use OPFS" }).click();
await page.waitForTimeout(1200);
console.log("title:", await title());

console.log("handles:", await page.evaluate(async () => {
    const m = await import("/src/services/workspace.mjs");
    return (await m.listHandles()).map(h => h.id).sort();
}));

await showRecents();
await page.waitForTimeout(300);
console.log("remove buttons:", await page.evaluate(() => document.querySelectorAll("file-tree .remove-item").length));
await page.locator("file-tree .remove-item").first().click();
await page.waitForTimeout(500);
console.log("handles after remove:", await page.evaluate(async () => {
    const m = await import("/src/services/workspace.mjs");
    return (await m.listHandles()).map(h => h.id).sort();
}));
await browser.close();
