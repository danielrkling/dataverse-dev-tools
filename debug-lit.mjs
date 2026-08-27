import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 300)); });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(5000);
const res = await page.evaluate(() => {
    const ft = document.querySelector("file-tree");
    return {
        defined: !!customElements.get("file-tree"),
        litDefined: !!customElements.get("lit-undefined") || typeof customElements.get("file-tree"),
        upgraded: ft instanceof HTMLElement,
        shadowChildren: ft?.shadowRoot ? ft.shadowRoot.childElementCount : "no shadow",
        hasUpdatePending: !!ft?.hasUpdated,
    };
});
console.log(JSON.stringify(res));
await browser.close();
