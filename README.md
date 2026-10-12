# Agent Atrium

Your coding-agent threads, as bots in a glass office.

Every thread on this machine — Claude Code, Codex, VS Code chat and more — is a small bot.
Each repo gets its own glass room on an open office floor, with a desk for every thread. New
bots arrive at reception, walk to their desks and get to work; the screens show what each one
is doing. A bot that needs you stops and holds a `?` over its head and joins the front desk at
the top of the screen. Click it for its staff badge: open the thread back in the app it came
from, or message the bot right there and its reply comes back to the badge.

The scanner reads the agents' own files on your machine and uploads nothing. Agent Atrium
has no account and never edits those files itself. Your layout is saved in `data/atrium.json`.
A message you send a bot goes through that agent's own CLI and configured model provider;
the CLI records the turn in its session and uses your existing account and permissions.

## Run it

Needs [Node 22.13 or newer](https://nodejs.org).

**Windows, no command prompt afterwards.** Once, in the project folder:

```powershell
npm install
powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-windows.ps1
```

That puts **Agent Atrium** on your Desktop and in the Start menu, and starts it in the
background when you log in. Add `-NoStartup` to skip the login entry, or `-Remove` to take
every shortcut away again.

The shortcut starts the server hidden if it is not already running, then opens the page. After
a `git pull` it rebuilds and restarts only what changed, so the next click picks up new code.
Logs and errors are in `data/`.

**Any platform, from a terminal:**

```bash
npm install
npm start        # build, then serve on http://localhost:5274
npm run dev      # or the live-reloading dev server
npm test
```

It answers only on `127.0.0.1` by default. Set `AGENT_ATRIUM_HOST=0.0.0.0` to reach it from
another device on your network.

## Office styles

Pick one in **Settings → Office style**, or press `Tab` to step through them. Each is its own
colour story: a gradient sky the floor fades into, a floor with real relief (bevelled tiles,
planks, stone or carpet, each with its own normal map), soft shadows from a tinted key light,
a rim light in a second colour that outlines the bots, and a touch of depth of field.

| Style | Look |
| --- | --- |
| **Glass Studio** (default) | Pearl-white glass rooms, cool reflections and long afternoon shadows |
| **Daylight Office** | Late-afternoon daylight on carpet and oak, soft blue shade behind white frames |
| **Sunset Loft** | Amber evening light across dark timber floors, an orange sky behind |
| **Greenhouse** | Low sunlight through steel and glass, warm stone and deep leafy shadows |
| **Neon Night** | Low moonlight, silver-blue highlights and violet edges across a dark tiled floor |

Every style is the same office. Your rooms, bots and layout stay put when you switch.

## Office stats

Click **Office stats** below the status counters for recorded tokens by assistant, model and
repository. Bot badges also show input/output, cached input and context headroom when reported.
The view includes scanned hidden and archived sessions; it excludes helper/subagent logs and
cloud-only work. Totals are local session records, not a billing statement. Forked sessions may
repeat inherited history, and providers may omit some usage.

- **Claude Code:** assistant-message usage, deduplicated by message ID; input includes cache
  reads and writes. The local logs do not expose a dependable remaining subscription allowance.
- **Codex:** cumulative token snapshots, model changes and last-call context capacity; remaining
  allowance windows and reset times are shown when recorded. These limits may be shared across
  models. Old reports are marked, and expired windows stay unknown until a new report arrives.
- **VS Code Chat:** provider-reported whole-turn model totals where available. Older records
  contain latest-call input and accumulated output, which are labelled partial. Missing usage,
  including local models that do not report it, stays unknown. Copilot credits used are shown
  on a badge when recorded; they are not a remaining account balance.

Usage is read locally without making provider requests or reading authentication credentials.
Unchanged logs are cached; appended records are read incrementally. Provider-usage links let
you check the authoritative account view yourself.

## Reading the office

- **A room per repo.** A busy repo grows into a bigger room, with its parts joined by floor. The
  sign on its wall is the repo's name.
- **A desk per thread.** Each thread gets its own workstation, picked from its id: a focus desk,
  dual or triple screens, a laptop rig, a desk with a build server, or a planning desk with a
  whiteboard. The screens scroll code in the bot's status colour: busy green while it works, slow
  blue while it waits on you, a stalled red on an error, gold when its work shipped.
- **The bots.** Each has a monitor for a head, its face on an LED screen behind glass, with a
  halo floating above it and light rings round its ears, both in its status colour, so you
  can read the whole floor from straight above. Body colour is the agent: Claude Code bots are
  orange, Codex bots are black, and everything else is blue.
- **Badges are the status.** `?` waiting on you, `!` hit an error, a keyboard means typing at
  its desk right now, `✓` its pull request landed. A bot with no badge is idle. One that has been
  quiet for three days dozes off by its desk, and so does one whose error is days old.
- **The commons** around reception has a lounge, a coffee bar, a water cooler, a ping-pong table,
  an arcade cabinet and a status board showing who is at work, who needs you and who is stuck.
- **The open floor** around the rooms has potted trees with bench rings, lamp posts, plant
  clusters and the odd sculpture, with glowing specks drifting through the air.
- **Delivery drones** carry parcels from reception to the desks.
- **Quiet repos fold away.** A room where every thread has been silent for three days leaves the
  floor and comes back in the same place when one wakes up. Turn this off in
  **Settings → View → Hide dormant repos**.

The **front desk**, at the top of the screen, lists the bots waiting on you or stuck, newest
first; click one to go to it. It is not there when nobody needs you. The tab title counts them
too, such as `(2 need you · 1 blocked)`, and **Settings → Alerts** turns on desktop
notifications for new ones while the tab is in the background.

## Getting around

| | |
| --- | --- |
| **Drag** | Grab the floor and move it |
| **Right-drag** (or ⌃ / ⇧ / middle-drag) | Tilt and turn |
| **Scroll** | Zoom toward whatever is under the cursor |
| **Two fingers** | Pinch to zoom, drag to move |
| **Arrows**, **+** / **−** | Move and zoom from the keyboard |

The view opens on the whole office, centred in the space beside the panels.
**Reset view** (`0`) comes back to it.

## Clicking a bot

Its **staff badge** opens next to it: the repo across the top in its room's colour, the thread
as its name, the agent as its role, its status as a presence light, and its branch, model and
working folder. The camera follows the bot until you put the badge away; the crosshair on the
badge turns following off.

- **Open** (`Enter`) takes you back to the thread where it lives and brings that window to the
  front. A session you ran in VS Code opens in VS Code, in the window that has its folder; a
  desktop-app session opens in the Claude or Codex app. On Linux, bringing the window forward uses
  `wmctrl` or `xdotool` when one is installed (X11). *Settings → View → Open threads in:
  Terminal* resumes it with the agent's own CLI instead.
- **Viewed** (`V`) puts its hand down until it does something new.
- **Archive** (`A`) sends the bot back to reception. Nothing is changed in the agent's own records.

### Messaging a bot

Under the buttons is a message box (`R` puts the cursor in it). Type an instruction, or start
from **Continue**, **Where are you at?** or **Run the tests**, and press `Enter`. The line
under the box says where it will go before you send:

- **In the background**, when the agent's CLI is installed (`claude` for Claude Code, `codex`
  for Codex). The CLI runs one turn of that same session in its folder, the bot works at its
  desk while it does, and the reply lands on the badge with a toast. One message at a time per
  bot. With **Can edit files** off, Claude uses Plan mode and Codex uses a read-only sandbox.
  Enable it to continue implementation: Claude uses `acceptEdits` with your CLI's configured
  permissions, and Codex uses `workspace-write` with approvals disabled. Read-only Claude
  replies inspect files; enable edits or use the app to run commands such as tests.
- **In the app**, when there is no CLI, the thread is mid-turn, or you click **Type it in the app
  instead**. A Claude Code session in VS Code opens with your message already typed in its
  input; anywhere else the thread opens and your message is on the clipboard to paste.

Click a room's floor or its sign for the repo: start a **new conversation** there (`C`), open
the folder, copy its path, or hide the room. Hidden rooms are listed at the foot of the panel.

Hold the mouse on a room's floor for a moment to pick it up, and drop it somewhere else on the
grid. The layout is remembered.

## Keys

| Key | Does |
| --- | --- |
| `H` / `Ctrl \` | Hide every panel |
| `S` | Settings |
| `N` | Fly to the next bot waiting on you |
| `Enter` / `A` / `V` | Open / archive / mark viewed |
| `R` | Message the selected bot |
| `C` | New conversation in the open room's repo |
| `O` | Orbit mode, a slow sweep around the office |
| `Tab` | Next office style |
| `M` | Mute |
| `P` | Screenshot |
| `0` | Reset the view |
| `Esc` | Deselect, then close the room |
| `?` | Help |

## Which agents it reads

| Agent | Notes |
| --- | --- |
| **Claude Code** | Desktop app, CLI and the VS Code extension, including worktrees |
| **Codex** | Desktop app, CLI and the VS Code extension. Its own helper and review threads are left out |
| **VS Code chat** | The built-in chat, including custom and local models |
| **Cursor** | Agent transcripts |
| **OpenCode** | Top-level sessions |
| **Antigravity CLI** | Transcripts |
| **Hermes** | Sessions per profile |
| **Kilo Code** | Top-level sessions |
| **Your own agents** | Any agent that writes a small JSON status file. See [docs/custom-agents.md](docs/custom-agents.md) |

Every agent that is installed shows up at once. To add a new one in code, see
[server/harnesses/README.md](server/harnesses/README.md).

## Settings worth knowing

- **Quality preset**, from *Potato* to *Ultra*. *Adaptive quality* lowers the resolution by
  itself if frames get slow.
- **Max bots** caps how many are drawn. The ones that need you are always kept.
- **Delivery drones**: off, some or full.
- **Sound**: a quiet room tone, typing where work is happening, drones going past, and a chime
  when a bot starts waiting on you. It is on, but silent until your first click, as browsers
  require.

## Credits and licence

Agent Atrium is a fork of [Bot Crossing](https://github.com/Station-Sciences/bot-crossing) by
**Jarren Rocks**, used under the MIT licence. It is not affiliated with or endorsed by that
project. The office, its desks, commons and styles, the interface, messaging and the bots'
monitor-head design are this project's own.

The code is [MIT](LICENSE). The bots' body and animations in `public/assets/` come from
**[Kay Lousberg](https://kaylousberg.com)**'s CC0
[Character Animations](https://kaylousberg.itch.io/kaykit-character-animations) pack. The
interface type is Barlow and Barlow Semi Condensed by Jeremy Tribby, under the
[SIL Open Font License](public/fonts/OFL.txt). The status badges are
[Material Design Icons](https://pictogrammers.com/library/mdi/) (Apache-2.0). See
[CREDITS.md](public/assets/CREDITS.md).

Not affiliated with Anthropic, OpenAI, Microsoft, Google or any other agent vendor.
