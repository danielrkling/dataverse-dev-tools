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
import tailwind from "./commands/tailwind.mjs";
import { uploadCommand, previewCommand, cacheCommand } from "./commands/dataverse.mjs";
import git from "./commands/git.mjs";
import gitlab from "./commands/gitlab.mjs";
import "./components/terminal.mjs";
import "./components/file-tree.mjs";
import "./components/editor-pane.mjs";


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
terminal.registerCommand(tailwind);
terminal.registerCommand(uploadCommand);
terminal.registerCommand(git);
terminal.registerCommand(esbuild);
terminal.registerCommand(cacheCommand)