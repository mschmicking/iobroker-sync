# Screenshots

What to capture, and what not to.

## `edit-loop.png` — the hero image (referenced from the README)

**Two terminal panes side by side** (tmux split, or two windows):

- **Left:** an editor showing a small script, then `iob-sync push` reporting the upload.
- **Right:** `iob-sync logs` already running, where the script's own output appears a
  second later.

This one image carries the whole pitch: edit locally in your own editor, push, and see
the result immediately — without ever opening the Admin UI. It is also the only part of
the tool a static screenshot can show that a feature list cannot.

An even stronger variant, if you want to spend the time: make the pushed script contain a
deliberate error, so the right pane shows the compile failure arriving. That demonstrates
*why* `logs` exists — `push` alone reports success either way.

### Capture settings

- **~100 columns**, and only as many rows as you need. Wide screenshots shrink to
  unreadable on the npm page.
- **Dark theme**, large font. Assume it will be viewed at half size on a phone.
- Leave colour on — do **not** set `NO_COLOR`. The green/red diff and severity colouring
  is a good part of what makes the output legible.
- Trim the prompt to something short and neutral (`$`), not a full path with your
  username in it.
- Save as PNG at this path: `docs/images/edit-loop.png`.

### Before you publish it — check for personal data

The screenshot goes in a public repository and onto the npm page. Real ioBroker instances
leak more than people expect:

- **Script and folder names** often contain room names, family members' names, or device
  locations.
- **Log lines** are worse — scripts log real state, and messages routinely include room
  names, times someone came home, or window/door status.
- **Hostnames and IPs** appear in the `iob-sync logs` banner and in `init` output.
- The **`from` column** in log output shows your adapter instances, which is harmless.

Safest approach: create two or three throwaway scripts with neutral names
(`demo/hello.ts`, `demo/broken.ts`) on a test instance, or point at a scratch javascript
instance, and screenshot only those. Failing that, review every visible line before
committing the file — a screenshot cannot be un-published.

## Optional second image

`log-stream.png` — `iob-sync logs --level error` alone, showing a real failure being
caught. Only worth it if the hero image does not already show an error.
