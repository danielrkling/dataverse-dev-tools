import { test, expect } from "@playwright/test";

test("web awesome split panel + font awesome icons render", async ({ page }) => {
    await page.goto("/");

    // Web Awesome split panel should be defined and present in the shell.
    await expect
        .poll(() => page.evaluate(() => !!customElements.get("wa-split-panel")), { timeout: 15000 })
        .toBe(true);

    const splitPanels = page.locator("ide-app wa-split-panel");
    await expect(splitPanels.first()).toBeVisible();

    // Three slotted panes exist.
    await expect(page.locator('ide-app [slot="sidebar"]')).toHaveCount(1);
    await expect(page.locator('ide-app [slot="editor"]')).toHaveCount(1);
    await expect(page.locator('ide-app [slot="terminal"]')).toHaveCount(1);

    // File-tree action buttons should be Web Awesome buttons with Font Awesome SVG icons.
    const sidebar = page.locator("file-tree");
    const newFolderBtn = sidebar.locator("#new-folder");
    await expect(newFolderBtn).toBeVisible({ timeout: 15000 });
    await expect(newFolderBtn).toHaveJSProperty("localName", "wa-button");
    const svgCount = await newFolderBtn.locator("svg").count();
    expect(svgCount).toBe(1);

    // The sidebar should show its recents list before a folder is opened.
    await expect(sidebar.locator(".recent-item").first()).toBeVisible({ timeout: 15000 });

    // The terminal should start disabled until a folder is selected.
    const input = page.locator("web-terminal #input");
    await expect(input).toBeDisabled();
});

test("refresh keeps the tree rendered and clears the terminal hint", async ({ page }) => {
    await page.goto("/");

    // Open the OPFS workspace via the sidebar's "Use OPFS Workspace" button.
    const opfsBtn = page.locator("file-tree .recent-item", { hasText: "Use OPFS Workspace" });
    await expect(opfsBtn).toBeVisible({ timeout: 15000 });
    await opfsBtn.click();

    // Tree mounts in #mount and the spinner is gone.
    const mount = page.locator("file-tree #mount");
    await expect(mount).toBeVisible();
    await expect(page.locator("file-tree #loading.visible")).toHaveCount(0, { timeout: 15000 });

    // Terminal is now enabled and the "no folder open" hint is cleared.
    await expect(page.locator("web-terminal #input")).toBeEnabled();
    await expect(page.locator('web-terminal [data-disabled-hint]')).toHaveCount(0);

    // Click refresh: spinner appears then disappears, and the tree container
    // (rendered by @pierre/trees) must survive — it must not be wiped blank.
    const container = page.locator("file-tree #mount file-tree-container");
    await expect(container).toHaveCount(1);
    await page.locator("file-tree #refresh").click();
    await expect(page.locator("file-tree #loading.visible")).toHaveCount(0, { timeout: 15000 });
    await expect(container).toHaveCount(1);
});

