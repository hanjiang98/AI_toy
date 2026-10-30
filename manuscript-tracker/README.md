# Manuscript Tracker

**English** | [简体中文](README.zh-CN.md)

> [!NOTE]
> This project was generated with [Claude Code](https://claude.com/claude-code) and has been manually verified and tested. It is intended for teaching purposes only. Feedback is welcome: please [open an issue](https://github.com/hanjiang98/AI_toy/issues).

**Try it:** https://hanjiang98.github.io/AI_toy/manuscript-tracker/

A small web page for researchers to keep track of their journal submissions. Paste an editorial email (submission confirmation, status update or decision) and the page records the journal, manuscript ID, title, date, status and revision deadline. Later emails about the same paper are added to its timeline. The interface is available in English and Chinese.

## Features

- Reads emails from IEEE (ScholarOne / Research Exchange), Elsevier (Editorial Manager) and Nature Portfolio (Springer Nature). You check the extracted fields before anything is saved.
- Matches follow-up emails to the right paper, including revision IDs such as `.R1`, `R1` or `A`.
- Filters for in progress, revision needed, accepted and closed, with days since submission and revision countdowns.
- JSON backup and import, and CSV export for Excel.
- Optional sync across devices through your own GitHub account.

## Privacy

- Each visitor has their own separate list. Nobody else, including the author of this page, can see your records.
- Records are stored in your browser (`localStorage`). There is no server, no analytics and no third-party script.
- Emails are parsed in your browser by [parser.js](parser.js).
- Without GitHub sync, your records stay in the browser where you created them. Clearing site data removes them. Export a backup now and then.

## Sync across devices with GitHub (optional)

Your records can be kept in a **private repository in your own GitHub account**. The page talks to `api.github.com` directly. No other server is involved, and nobody else gets access.

1. [Create a private repository](https://github.com/new?name=manuscript-tracker-data&visibility=private), for example `manuscript-tracker-data`.
2. [Create a fine-grained personal access token](https://github.com/settings/personal-access-tokens/new?name=Manuscript%20Tracker&contents=write&expires_in=365):
   - **Repository access:** choose *Only select repositories* and pick the repository from step 1.
   - **Permissions:** set *Contents* to *Read and write*. Nothing else is needed.
3. In the tracker, click **GitHub sync**, then enter the repository name and paste the token.
4. On every other device, repeat step 3 with the same repository. You can reuse the token, or create one per device.

The tracker writes a single file, `manuscripts.json`, to that repository. It syncs after every change, when the page opens, and when you return to the tab. If two devices edit the same manuscript, the most recent edit wins. Deleted manuscripts stay deleted on every device.

**Security notes**

- The tracker refuses to sync to a public repository.
- The token is saved in this browser's storage only, or for this session only if you untick *Remember on this device*. Anyone who can use your browser profile can read it. Use a token limited to this one repository, give it an expiry date, and [revoke it](https://github.com/settings/personal-access-tokens) if a device is lost.
- The page sends a Content Security Policy that only allows connections to `api.github.com`.
- OAuth login ("Sign in with GitHub") is not used because it needs a backend server to hold a client secret, and this project deliberately has no server.

## Run locally

Download the `manuscript-tracker` folder and open `index.html` in a browser. It needs no install and no build step. GitHub sync also works from a local file.

## Project structure

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Page and styles |
| `app.js` | Interface, storage and sync wiring |
| `i18n.js` | English and Chinese text |
| `parser.js` | Email parsing (no DOM dependencies) |
| `github-sync.js` | GitHub REST client, merge logic and syncer |
| `tests/parser-test.html` | Parser test cases |
| `tests/sync-test.html` | Merge and sync tests against a mock GitHub API |
| `build-artifact.sh` | Optional: bundles the page into one file for a claude.ai artifact |

## Tests

Open `tests/parser-test.html` and `tests/sync-test.html` in a browser. Each page lists every case and ends with a summary such as `18/18 passed`.

## Contributing

Issues and pull requests are welcome, especially emails the parser gets wrong.

- **Before posting any email, remove names, email addresses, manuscript titles and IDs.**
- When you change `parser.js`, add a test case to `tests/parser-test.html`.
- Keep the project dependency-free: plain HTML, CSS and JavaScript with no build step.

## License

[MIT](../LICENSE). Provided as is, without warranty. Do not rely on this tool as your only record of your submissions.
