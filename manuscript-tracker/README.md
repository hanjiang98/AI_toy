# Manuscript Tracker

**Use it:** https://hanjiang98.github.io/AI_toy/manuscript-tracker/

A small web page for researchers to keep track of their journal submissions. Paste an editorial email (submission confirmation, status update or decision) and the page records the journal, manuscript ID, title, date, status and revision deadline. Later emails about the same paper are added to its timeline. English and Chinese (中文) interfaces.

## Your data stays on your computer

- Records are stored only in your own browser (`localStorage`). There is no server, no account, no analytics, and nothing is uploaded.
- Each person who opens the page has their own separate list. Nobody else, including the author of this page, can see your records.
- Emails are parsed in your browser by [parser.js](parser.js). You can read it.
- Records stay in the browser where you created them. Clearing site data removes them, and they do not move to another device by themselves. Use **Export → Backup (JSON)** now and then, and **Import** to restore or move to another browser. **Export → Spreadsheet (CSV)** opens in Excel.

## Supported submission systems

| Publisher | System | Manuscript ID examples |
|---|---|---|
| IEEE | ScholarOne / Research Exchange | `TSTE-04321-2026`, revisions `TSTE-04321-2026.R1` |
| Elsevier | Editorial Manager | `APEN-D-26-04567`, revisions `APEN-D-26-04567R1` |
| Nature Portfolio | Springer Nature MTS | `NENERGY-26-01234`, revisions `NCOMMS-26-56789A` |

Recognised events: submitted, with editor, under review, reviews complete, major/minor revision, revision requested, reject & resubmit, revision submitted, accepted, proofs, published, rejected, transferred, withdrawn. Emails from other systems still work, but you may need to correct some fields before saving.

## Run it yourself

Download this folder and open `index.html`. It needs no install, build step or internet connection.

## Development

- `parser.js`: email parsing, with no DOM dependencies.
- `app.js`, `i18n.js`, `index.html`, `styles.css`: the interface.
- `tests/parser-test.html`: open it in a browser to run the parser test cases. Add a case there when you improve a pattern.
- `build-artifact.sh`: bundles the page into one file for publishing as a claude.ai artifact. That version can also save to a signed-in user's private claude.ai storage. It is not needed for GitHub Pages.

Found an email the parser gets wrong? Open an issue with the email text, and remove names, addresses and the manuscript title first.
