# Banking Aid statement fetcher

A Firefox add-on for Banking Aid users: on your bank's statements page it
lists the statements Banking Aid is missing, opens each one, takes the PDF
(from the page's viewer, or by pressing its Download button — the download is
caught, not saved) and uploads it to your Banking Aid. Then it goes back and
works through the next pages until nothing is missing.

## What it stores

Only in your browser (`browser.storage.local`), never anywhere else:

- your Banking Aid address and API token
- the bank sites you've turned it on for
- which statements it has already sent (card name + statement date)

Statement PDFs pass through memory straight to your Banking Aid. The add-on
talks to nothing else.

## Install

Download the latest `releases/statement_fetcher-*.xpi` and open it in Firefox.
It updates itself from `updates.json`.

## Set up

1. Toolbar button → **Settings**: your Banking Aid address, your API token
   (Banking Aid → Settings → your sign-in card) and your bank's site.
2. Open your bank's statements page, toolbar button → **Show missing
   statements on this page** → **Send all to Banking Aid**.

## Release

`node publish.mjs` — privacy check, version bump, Mozilla signing (unlisted),
`releases/` + `updates.json`, push.
