import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto("http://localhost:5199/");
await page.waitForTimeout(3000);
await page.locator("file-tree .recent-item", { hasText: "Use OPFS" }).click();
await page.waitForTimeout(1500);

// create folder + nested file
await page.evaluate(() => { window.prompt = () => "proj"; });
await page.locator("file-tree #new-folder").click();
await page.waitForTimeout(500);
await page.evaluate(() => { window.prompt = () => "a.txt"; });
await page.locator("file-tree #new-file").click();
await page.waitForTimeout(500);

// 1) row right-click should NOT open the empty-space menu
await page.locator("file-tree button[data-item-path='a.txt']").click({ button: "right" });
await page.waitForTimeout(300);
const emptyMenuOnRow = await page.evaluate(() => !!document.querySelector("body > div[style*='z-index: 10000']"));
console.log("empty-menu leaked onto row right-click:", emptyMenuOnRow);
await page.keyboard.press("Escape");
await page.mouse.click(700, 300);
await page.waitForTimeout(200);

// 2) focus stays in tree after opening a file
await page.locator("file-tree button[data-item-path='a.txt']").click();
await page.waitForTimeout(600);
const active = await page.evaluate(() => {
    const el = document.querySelector("file-tree").shadowRoot.activeElement;
    return el?.getAttribute?.("data-item-path") ?? el?.tagName;
});
console.log("active element after opening file:", active);

// 3) F2 now works instantly after click (rename editor state check via disk rename)
await page.keyboard.press("F2");
await page.waitForTimeout(400);
const renameState = await page.evaluate(() => {
    const tree = document.querySelector("file-tree")._tree;
    // probe: is a renaming editor mounted anywhere in the container?
    const container = document.querySelector("file-tree").shadowRoot.querySelector("file-tree-container");
    return { editing: !!container.shadowRoot.querySelector("textarea, input, [contenteditable='true']") };
});
console.log("rename editor mounted after F2:", JSON.stringify(renameState));
await browser.close();
