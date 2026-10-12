# Custom agents

Any agent can appear in Agent Atrium without writing an adapter: it writes one small JSON file
describing itself, and the office picks it up on its next scan (every 15 seconds).

## Where the files go

One `.json` file per agent in `~/.agent-atrium/agents/`. On Windows that is
`%USERPROFILE%\.agent-atrium\agents\`. Set `AGENT_ATRIUM_STATUS_DIR` to use another folder.

The custom-agents source turns on as soon as that folder exists.

## The file

```json
{
  "id": "my-worker",
  "title": "Review the checkout flow",
  "project": "storefront",
  "cwd": "C:\\work\\storefront",
  "status": "waiting",
  "message": "Ready for your review",
  "url": "https://example.com/tasks/my-worker"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Letters, digits, `_`, `-` or `.`, up to 100 characters. Keep it unique across your agents |
| `status` | yes | `working`, `waiting`, `blocked`, `idle` or `done` |
| `title` | | What the bot's card shows as the thread title. Defaults to the id |
| `project` | | The room it stands in. Defaults to the last folder of `cwd`, then to *Custom agents* |
| `cwd` | | Absolute folder, used for the room's folder buttons and new conversations |
| `message` | | A one-line preview |
| `url` | | An `http` or `https` link that **Open** goes to. Without one, Open is disabled |
| `model` | | Shown on the card |
| `archived` | | `true` sends the bot back to reception |
| `createdAt`, `updatedAt` | | Epoch milliseconds. Without `updatedAt`, the file's modification time is used |

How each status shows:

- `working`: the bot types at its desk, with a keyboard badge. If the file has not been updated for 30
  minutes the bot stops working, so a crashed agent does not work forever. Rewrite the file at
  least that often while it works.
- `waiting`: it holds up a `?` and counts in the tab title.
- `blocked`: it shows a `!`.
- `done`: it celebrates with a `✓`.
- `idle`: no badge.

## Writing it safely

Write to a temporary name and rename it to `.json`, so the office never reads half a file.
Files over 64 KB, broken JSON and records with a bad `id` or `status` are skipped. Delete the
file to remove the bot.

Agent Atrium only reads these files. It never runs anything they name: links other than
`http`/`https` are ignored.

## VS Code chat

VS Code's built-in chat is read without any setup, including chats that use custom or local
models. Regular VS Code and Insiders are both read. Set `AGENT_ATRIUM_VSCODE_USER_DIR` to a
VS Code `User` folder if yours lives somewhere else.

**Open** returns a chat to its own session in its own workspace (VS Code 1.128 or newer). A chat
with no workspace folder shows with Open disabled. VS Code may ask once whether to allow the
link.
