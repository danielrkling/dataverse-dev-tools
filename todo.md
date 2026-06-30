# Architecture Changes
- Create event system on the plugin manager to
- Use one FileSystemOberserver on the root. Dispatch events through system
- When esbuild or tailwind compeletes it can dispatch an event that upload could listen to directly
- When upload or publish completes it can dispatch an event that the preview plugin is listening to
- Move feature initialization into plugin instead of main (setting up event listeners etc). can be triggered by event or direct method
- ✅ Allow glob matching on the event listeners (data filters: string glob→path, or obj key→glob)
- Move things into utils folder that could be shared

# Feature Changes
## Uploading
- We should only allow uploading of valid web reources. should not emit error during watch. should emit error if typed in command
- Command based upload loggin should match styling of watcher
- command based upload should allow folder/glob
- Gather uploads together before publishing. maybe 1 sec window
- create cache of name:webresourceid so we only have get once
- use put if we have webresourceid else patch

## Esbuild
- Allow cli arguments to override existing config
- Allow reading of tsconfig
- use esbuild context and rebuild when watch is involved
- ✅ use the fs plugin to track which files to listen to for watch instead of list (removed config.watch requirement)
- explore how to add something like solid-plugin
- allow transform as well

## Run
- We can bundle code with esbuild so we can use import and typescript (maybe by default with flag to run "raw")
- capture console logs and duplicate to terminal during run (maybe default with flag)

## Init-Config
- ✅ esbuild file is optional (init returns gracefully if no config)

## Tailwind
- ✅ importCss and css just get merged, we dont need both.
  - ✅ Config "css" is now an array of filenames/urls/raw-styles
  - ✅ Joined with "\n" and passed to compile()
  - ✅ URL/CDN support via loadStylesheet (fetches from CDN)
- ✅ deafult extensions should include .mjs, and .ts
- ✅ Explore using tailwind "compile" directly with WasmScanner class parser.
  - ✅ Switched from generateTailwindCSS to real compile() API
  - ✅ @import support via custom loadStylesheet resolver (reads from virtual fs, fetches URLs, or resolves tailwindcss internal CSS from CDN)
  - ✅ @plugin support via custom loadModule resolver (bundles local files with esbuild, imports npm packages from esm.sh)
  - ✅ WasmScanner from tailwindcss-iso for class extraction from content files

# New features
## Flatten
- command to combine files in glob/folder into one markdown file with timestamp. purpose is to condense project into one file for easy upload to ai/llm