import { createCommand } from "../terminal.mjs";
import { object, optional, argument, string, message } from "@optique/core";

/** @type {Set<Window>} */
const previewWindows = new Set();

/** @param {Window} win */
function registerPreviewWindow(win) {
  previewWindows.add(win);
}

const previewParser = object({
  path: optional(
    argument(string({ metavar: "PATH" }), {
      description: message`Web resource path to preview`,
    }),
  ),
});

export const previewCommand = createCommand({
  name: "preview",
  parser: previewParser,
  aliases: ["pv"],
  description: "Preview a web resource in a new tab",
  usage: "preview [path]",
  brief: "Preview a web resource in a new tab",
  execute: async (parsed, term) => {
    let path = parsed.path;
    const { fs } = term;

    if (!path) {
      try {
        const config = JSON.parse(
          /** @type {string} */ (
            await fs.readFile("dataverse.config.json", { encoding: "utf8" })
          ),
        );
        path = config.upload?.preview;
      } catch {
        return "No preview path configured and no path provided.";
      }
    }
    if (!path) return "Could not determine preview path.";
    const url = `${location.origin}/WebResources/${path}`;
    const win = window.open(url);
    if (win) registerPreviewWindow(win);
    return `Opening ${url}`;
  },

  init: (terminal) => {
    terminal.addEventListener("publish:complete", () => {
      for (const win of previewWindows) {
        try {
          win.location.reload();
        } catch {
          previewWindows.delete(win);
        }
      }
    });
    terminal.addEventListener("preview:refresh", () => {
      for (const win of previewWindows) {
        try {
          win.location.reload();
        } catch {
          previewWindows.delete(win);
        }
      }
    });
  },
});
