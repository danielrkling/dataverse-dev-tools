import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(4000);
const info = await page.evaluate(() => {
    const root = document.getElementById("root");
    const inner = document.getElementById("inner");
    const gcs = getComputedStyle(root);
    const ics = getComputedStyle(inner);
    return {
        defined: !!customElements.get("wa-split-panel"),
        rootDisplay: gcs.display, rootGridRows: gcs.gridTemplateRows, rootH: Math.round(root.getBoundingClientRect().height),
        innerDisplay: ics.display, innerGridCols: ics.gridTemplateColumns, innerW: Math.round(inner.getBoundingClientRect().width),
        paneEditorH: Math.round(document.getElementById("pane-editor").getBoundingClientRect().height),
        paneTermH: Math.round(document.getElementById("pane-terminal").getBoundingClientRect().height),
    };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
