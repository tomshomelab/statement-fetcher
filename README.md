# Banking Aid statement fetcher

A browser add-on (Firefox, Chrome, Opera, Edge) for Banking Aid users: on your bank's statements page it
lists the statements Banking Aid is missing, opens each one, takes the PDF
(from the page's viewer, or by pressing its Download button — the download is
caught, not saved) and uploads it to your Banking Aid. Then it goes back and
works through the next pages until nothing is missing.

## What it stores

Only in your browser (`browser.storage.local`), never anywhere else:

- your Banking Aid address and API token
- the bank sites you've used it on
- which statements it has already sent (card name + statement date)

Statement PDFs pass through memory straight to your Banking Aid. The add-on
talks to nothing else.

## Install

**Firefox:** download the latest `releases/statement_fetcher-*.xpi` and open it
in Firefox. It updates itself from `updates.json`.

**Chrome, Opera, Edge:** build it (`node build-chrome.mjs` → `dist/chrome`), open
`chrome://extensions` (Opera: `opera://extensions`, Edge: `edge://extensions`),
turn on **Developer mode**, press **Load unpacked** and pick the `dist/chrome`
folder. After an update, build again and press the add-on's ↻ reload button.
The same build zipped (`dist/statement-fetcher-chrome-<version>.zip`) is what the
Chrome Web Store takes. The Chrome build is the Firefox add-on's own scripts
with `chrome/compat.js` (Firefox's `browser` calls on Chrome's API) and a
Manifest V3 manifest.

## Set up

1. Toolbar button → **Settings**: your Banking Aid address, your API token
   (Banking Aid → Settings → your sign-in card) and your bank's site.
2. Open your bank's statements page, toolbar button → **Fetch missing
   statements on this page** → **Send all to Banking Aid**.

## Release

`node publish.mjs` — privacy check, version bump, Mozilla signing (unlisted),
`releases/` + `updates.json`, push.
