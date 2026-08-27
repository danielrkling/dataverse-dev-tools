import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("requestfailed", (r) => console.log("FAILED:", r.url().slice(0, 100)));
await page.goto("http://localhost:5199/");
await page.waitForTimeout(6000);
const res = await page.evaluate(() => ({
    splitPanel: !!customElements.get("wa-split-panel"),
    button: !!customElements.get("wa-button"),
    icon: !!customElements.get("wa-icon"),
    spinner: !!customElements.get("wa-spinner"),
}));
console.log(JSON.stringify(res));
await browser.close();
