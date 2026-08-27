import { test, expect } from "@playwright/test";
import { shouldHydrateModel, packageNameFromSpecifier, languageForPath } from "../src/services/editor.mjs";

test("languageForPath maps declaration files to typescript/javascript", () => {
    // Plain declaration variants must be typescript so the TS worker resolves them.
    expect(languageForPath("node_modules/valibot/dist/index.d.ts")).toBe("typescript");
    expect(languageForPath("node_modules/valibot/dist/index.d.mts")).toBe("typescript");
    expect(languageForPath("node_modules/valibot/dist/index.d.cts")).toBe("typescript");
    expect(languageForPath("src/types.d.ts")).toBe("typescript");
    expect(languageForPath("src/app.tsx")).toBe("typescript");
    expect(languageForPath("src/mod.mts")).toBe("typescript");
    expect(languageForPath("src/mod.cts")).toBe("typescript");
    expect(languageForPath("lib/index.js")).toBe("javascript");
    expect(languageForPath("lib/index.d.mts")).toBe("typescript");
    expect(languageForPath("README.md")).toBe("markdown");
});

test("shouldHydrateModel materializes code/declaration files and package.json", () => {
    expect(shouldHydrateModel("src/index.ts")).toBe(true);
    expect(shouldHydrateModel("src/app.tsx")).toBe(true);
    expect(shouldHydrateModel("lib/util.js")).toBe(true);
    expect(shouldHydrateModel("node_modules/valibot/dist/index.d.ts")).toBe(true);
    expect(shouldHydrateModel("node_modules/zod/package.json")).toBe(true);
    expect(shouldHydrateModel("node_modules/zod/lib/index.js")).toBe(true);
});

test("shouldHydrateModel skips non-code assets", () => {
    expect(shouldHydrateModel("README.md")).toBe(false);
    expect(shouldHydrateModel("src/styles.css")).toBe(false);
    expect(shouldHydrateModel("logo.png")).toBe(false);
    expect(shouldHydrateModel("data.json")).toBe(false);
});

test("packageNameFromSpecifier reduces to package name", () => {
    expect(packageNameFromSpecifier("valibot")).toBe("valibot");
    expect(packageNameFromSpecifier("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(packageNameFromSpecifier("./local")).toBeNull();
});
