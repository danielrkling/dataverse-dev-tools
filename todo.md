# Architecture Changes
- Create event system on the plugin manager to
- Use one FileSystemOberserver on the root. Dispatch events through system
- When esbuild or tailwind compeletes it can dispatch an event that upload could listen to directly
- When upload or publish completes it can dispatch an event that the preview plugin is listening to
- Move feature initialization into plugin instead of main (setting up event listeners etc). can be triggered by event or direct method
- Allow glob matching on the event listeners

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
- may be possible to use the fs plugin to track which files to listen to for watch instead of list
- explore how to add something like solid-plugin
- allow transform as well

## Run
- We can bundle code with esbuild so we can use import and typescript (maybe by default with flag to run "raw")
- capture console logs and duplicate to terminal during run (maybe default with flag)

## Init-Config
- esbuild file should be optional like tailwind/tsc

## Tailwind
- importCss and css just get merged, we dont need both.
  - We should just have config setting "css" that is an array of filenames/urls.
  - we just join them with "\n" and but pass it to importCSS
  - url support for cdn's "plugins" like daisyui
- deafult extensions should include .mjs, and .ts
- Explore using tailwind "complile" directly with either regex class parser or tailwind v3 parser or tailwindcss-iso class parser.
  - I think this would allow @imports
  - We can also use plugins if we import() a bundled code or from https

