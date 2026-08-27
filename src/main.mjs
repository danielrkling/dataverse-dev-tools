import { clear, help, echo } from "./commands/builtin.mjs";
import esbuild from "./commands/esbuild.mjs";
import { flatten, templateCommand } from "./commands/flatten.mjs";
import {
    lsCommand,
    catCommand,
    cdCommand,
    mvCommand,
    rmCommand,
    pwdCommand,
    statCommand,
    mkdirCommand,
} from "./commands/fs.mjs";
import { historyCommand } from "./commands/history.mjs";
import { npmCommand } from "./commands/npm.mjs";
import { openCommand } from "./commands/open.mjs";
import tailwind from "./commands/tailwind.mjs";
import { uploadCommand, previewCommand, cacheCommand } from "./commands/dataverse.mjs";
import git from "./commands/git.mjs";
import gitlab from "./commands/gitlab.mjs";
import "./components/terminal.mjs";
import "./components/file-tree.mjs";
import "./components/editor-pane.mjs";
// wa-icon lives inside editor-pane's shadow DOM — autoloader can't see it.
import "https://ka-f.webawesome.com/webawesome@3.12.0/components/icon/icon.js";

// --- Global layout hotkeys (VS Code-style) -------------------------------
// Ctrl+B  toggle sidebar   Ctrl+J  toggle/focus terminal
{
    /** @type {number | null} */
    let sidebarRestore = null;
    /** @type {number | null} */
    let terminalRestore = null;

    document.addEventListener("keydown", (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const rootPanel = /** @type {any} */ (document.getElementById("root"));
        const innerPanel = /** @type {any} */ (document.getElementById("inner"));

        if (e.key.toLowerCase() === "b" && rootPanel) {
            e.preventDefault();
            if (rootPanel.position > 0) {
                sidebarRestore = rootPanel.position;
                rootPanel.position = 0;
            } else {
                rootPanel.position = sidebarRestore ?? 250;
            }
        } else if (e.key.toLowerCase() === "j" && innerPanel) {
            e.preventDefault();
            if (innerPanel.position < 100) {
                terminalRestore = innerPanel.position;
                innerPanel.position = 100;
            } else {
                innerPanel.position = terminalRestore ?? 75;
                // Focus the terminal input after the panel re-expands.
                setTimeout(() => document.querySelector("web-terminal")?.shadowRoot?.querySelector("#input")?.focus());
            }
        }
    });
}

/** @type {import("./components/terminal.mjs").WebTerminal} */
export const terminal = /** @type {import("./components/terminal.mjs").WebTerminal} */ (document.querySelector("web-terminal"));

terminal.registerCommand(help);
terminal.registerCommand(clear);
terminal.registerCommand(echo);
terminal.registerCommand(historyCommand);
terminal.registerCommand(flatten);
terminal.registerCommand(templateCommand); 
terminal.registerCommand(lsCommand);
terminal.registerCommand(catCommand);
terminal.registerCommand(cdCommand);
terminal.registerCommand(mvCommand);
terminal.registerCommand(rmCommand);
terminal.registerCommand(pwdCommand);
terminal.registerCommand(statCommand);
terminal.registerCommand(mkdirCommand);
terminal.registerCommand(previewCommand);
terminal.registerCommand(npmCommand);
terminal.registerCommand(gitlab);
terminal.registerCommand(openCommand);
terminal.registerCommand(tailwind);
terminal.registerCommand(uploadCommand);
terminal.registerCommand(git);
terminal.registerCommand(esbuild);
terminal.registerCommand(cacheCommand)