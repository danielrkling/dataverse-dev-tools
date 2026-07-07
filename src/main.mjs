import { clear, help, echo } from "./commands/builtin.mjs";
import esbuild from "./commands/esbuild.mjs";
import { flatten } from "./commands/flatten.mjs";
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
import { initConfig } from "./commands/init-config.mjs";
import { npmCommand } from "./commands/npm.mjs";
import { openCommand } from "./commands/open.mjs";
import { previewCommand } from "./commands/preview.mjs";
import { runCommand } from "./commands/run.mjs";
import tailwind from "./commands/tailwind.mjs";
import { uploadCommand } from "./commands/upload.mjs";
import git from "./commands/git.mjs";
import { WebTerminal } from "./terminal.mjs";

/** @type {WebTerminal} */
export const terminal = /** @type {WebTerminal} */ (document.querySelector("web-terminal"));

terminal.registerCommand(help);
terminal.registerCommand(clear);
terminal.registerCommand(echo);
terminal.registerCommand(historyCommand);
terminal.registerCommand(flatten);
terminal.registerCommand(lsCommand);
terminal.registerCommand(catCommand);
terminal.registerCommand(cdCommand);
terminal.registerCommand(mvCommand);
terminal.registerCommand(rmCommand);
terminal.registerCommand(pwdCommand);
terminal.registerCommand(statCommand);
terminal.registerCommand(mkdirCommand);
terminal.registerCommand(initConfig);
terminal.registerCommand(previewCommand);
terminal.registerCommand(npmCommand);
terminal.registerCommand(runCommand);
terminal.registerCommand(openCommand);
terminal.registerCommand(tailwind);
terminal.registerCommand(uploadCommand);
terminal.registerCommand(git);
terminal.registerCommand(esbuild);
