import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(3000);
await page.evaluate(() => { window.prompt = () => "proj"; });
await page.locator("file-tree .recent-item", { hasText: "Use OPFS" }).click();
await page.waitForTimeout(1000);
await page.evaluate(() => document.querySelector("file-tree").showRecentFolders());
await page.waitForTimeout(800);
const res = await page.evaluate(() => {
    const btn = document.querySelector("file-tree").shadowRoot.querySelector(".remove-item");
    const part = btn.shadowRoot.querySelector("[part~='button']");
    const b = part.getBoundingClientRect();
    const icon = part.querySelector("wa-icon") || btn;
    const ir = icon.getBoundingClientRect();
    return {
        buttonW: Math.round(b.width),
        offsetFromCenter: Math.round((ir.left + ir.width / 2) - (b.left + b.width / 2)),
        justify: getComputedStyle(part).justifyContent,
        width: getComputedStyle(part).width,
    };
});
console.log(JSON.stringify(res));
await browser.close();
