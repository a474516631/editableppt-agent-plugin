# EditablePPT Agent Plugin

Batch-convert images — slide screenshots, exported slide PNGs, posters,
infographics — into **editable PowerPoint decks** from any AI agent that
supports [Agent Plugins](https://agent-plugins.org) (VS Code, GitHub Copilot,
Cursor, Codex, Kiro, OpenHands, …).

Each image becomes one slide with real, editable text boxes (matched fonts,
sizes and colors) over the cleaned image layers, using the same conversion as
[editableppt.com](https://editableppt.com).

> "Turn every PNG in `~/Desktop/keynote-export` into an editable PowerPoint."

## What's inside

This is a portable [Agent Plugins v1.0.0](https://agent-plugins.org/specification)
package:

```text
editableppt-agent-plugin/
├── plugin.json                         # manifest
├── mcp.json                            # stdio MCP server
├── skills/
│   └── images-to-editable-ppt/
│       ├── SKILL.md                    # workflow the agent follows
│       └── references/troubleshooting.md
├── server/
│   └── editableppt-mcp.mjs             # MCP server, zero dependencies (Node.js 18+)
└── test/                               # end-to-end test against a mock API
```

### MCP tools

| Tool | What it does |
| --- | --- |
| `editableppt_sign_in` | One-time browser sign-in (no passwords or API keys in the agent). |
| `editableppt_account` | Account, credit balance, credits per image. |
| `editableppt_convert_images` | Upload images/folders, wait, write the `.pptx`. Spends credits. |
| `editableppt_wait_for_job` | Resume waiting on a long job and write its `.pptx`. |
| `editableppt_list_jobs` | Recent jobs and their output files. |
| `editableppt_cancel_job` | Cancel unfinished conversions (refunded). |
| `editableppt_sign_out` | Sign out and revoke the plugin's key. |

Quality options:

- **standard** — editable text over the image layers.
- **layered** — also separates photos, icons/decorations, cards/buttons and
  the background into depth layers (`refine: true` rebuilds cards and buttons
  as native shapes).

Credit prices per image are shown by `editableppt_account`; the skill tells the
agent to confirm the cost with you before converting.

## Install

Requirements: Node.js 18+ on `PATH`, network access to `https://editableppt.com`.

Install the plugin from this repository with your client's plugin installer,
pointing it at `https://github.com/a474516631/editableppt-agent-plugin` (or a
local clone). See your client's setup instructions on
[agent-plugins.org/compatible-clients](https://agent-plugins.org/compatible-clients).

### Clients without Agent Plugins support

The pieces work on their own:

- **MCP server** — register a stdio server running
  `node /path/to/editableppt-agent-plugin/server/editableppt-mcp.mjs`.
  For example, in Claude Code:

  ```bash
  claude mcp add editableppt -- node /path/to/editableppt-agent-plugin/server/editableppt-mcp.mjs
  ```

- **Skill** — copy `skills/images-to-editable-ppt/` into the client's skills
  directory (for Claude Code: `~/.claude/skills/`).

## Sign-in and security

Sign-in reuses the PKCE-style device flow of the EditablePPT Figma plugin and
Chrome extension:

1. The MCP server generates a random `verifier` and opens
   `https://editableppt.com/agent-connect?challenge=<base64url(sha256(verifier))>`.
2. You sign in on the website and click **Authorize**.
3. The server polls `POST /api/agent/token` with its verifier. The first poll
   after approval receives an API key; approvals expire after 10 minutes and
   can be redeemed only once, and only by the process holding the verifier.

The key is hash-only on the server, hidden from your API key list, and stored
locally in the client's `PLUGIN_DATA` directory (or `~/.editableppt-agent`)
with owner-only file permissions. It is never written into the plugin files,
`mcp.json`, or tool output. `editableppt_sign_out` revokes it.

## Limits

PNG/JPG, up to 20 MB and 25 megapixels per image, up to 100 images per job.
A `.pptx` holds up to 20 slides; larger jobs are written as
`<title> (part 1).pptx`, `<title> (part 2).pptx`, …. Existing files are never
overwritten.

## Development

```bash
node --test test/*.test.mjs
```

Point the server at a local EditablePPT site with
`EDITABLEPPT_API_BASE=http://localhost:3000`. `EDITABLEPPT_NO_BROWSER=1`
disables opening the browser during sign-in.

## License

MIT
