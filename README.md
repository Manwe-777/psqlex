# psqlex

![Node](https://img.shields.io/badge/node-%3E%3D20.11-339933?logo=node.js&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![MCP server](https://img.shields.io/badge/MCP-server-8A2BE2)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

A small Postgres query runner that runs in your browser. Pick a database, write SQL, run it, and look at the query plan. It also has an MCP server, so AI agents can edit and run the same scripts while you watch.

## Requirements

- Node.js 20.11 or newer
- macOS or Linux
- pnpm, to build from source

## Install

```sh
git clone https://github.com/Manwe-777/psqlex.git
cd psqlex
bin/psqlex link
```

`link` adds `psqlex` to `~/.local/bin`. Make sure that folder is on your `PATH`. The first `psqlex start` installs dependencies and builds the app.

## Usage

```sh
psqlex start
```

This starts psqlex in the background and opens http://psqlex.localhost:7457. If that address does not load, use http://127.0.0.1:7457.

| Command | What it does |
| --- | --- |
| `psqlex start` | Start in the background and open the browser |
| `psqlex stop` | Stop it |
| `psqlex restart` | Stop, then start |
| `psqlex status` | Show whether it is running and which config file it uses |
| `psqlex logs` | Follow the server log |
| `psqlex run` | Run in the foreground |
| `psqlex mcp` | Run the MCP server over stdio |
| `psqlex config` | Print the config file path |

## Connections

Click **Connections** in the top bar to add, test, edit or remove databases. Connections are grouped by project.

They are saved to `~/.config/psqlex/config.json`, which only your user can read.

Connection URLs look like this:

```
postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

- If the password has `@ # / ? : %` in it, encode those characters. For example, `#` becomes `%23`.
- To keep a password out of the file, write `${MY_VAR}` and start psqlex with that environment variable set.
- SSL works like psql. psqlex tries an encrypted connection first and falls back to an unencrypted one. Add `?sslmode=require` to require encryption, or `?sslmode=verify-full` to also check the certificate.
- Tick **Read-only** on a connection to stop anything from writing to it.

## Writing and running SQL

| Shortcut | Action |
| --- | --- |
| `⌘ Enter` / `Ctrl Enter` | Run the selection, or the whole script |
| `⌘ E` / `Ctrl E` | Explain the statement under the cursor |
| `⌘ Shift E` / `Ctrl Shift E` | Explain analyze it (rolled back, so nothing is saved) |

- psql variables work. `:name` is inserted as written, `:'name'` as a quoted string, and `:"name"` as a quoted identifier. Set them with `\set name value` lines or in the Variables panel.
- The **read-only** box in the top bar runs everything in a transaction that is rolled back.
- Each statement gets its own results tab. You can copy results as TSV, CSV or JSON.

## Scripts

Each connection can have several scripts, shown as tabs above the editor. Use **+** to add one, double-click a tab to rename it, and click **×** twice to delete it.

Scripts are plain `.sql` files in `~/.local/share/psqlex/scripts/<project>/<connection>/`, and they save as you type. If anything else changes a file, whether an agent, your editor or another browser tab, the page updates right away.

With **follow agent** on, the page switches to whatever script an agent is working on, but only after you have stopped typing for a few seconds.

## MCP server

Add it to Claude Code:

```sh
claude mcp add -s user psqlex -- psqlex mcp
```

Or, while `psqlex start` is running, over HTTP:

```sh
claude mcp add -s user --transport http psqlex http://127.0.0.1:7457/mcp
```

| Tool | What it does |
| --- | --- |
| `list_connections` | List databases, optionally checking that each one is up |
| `list_tables`, `describe_table` | Read the schema |
| `run_sql`, `explain_sql` | Run or explain SQL. It shows up in an `agent` tab in the browser |
| `list_scripts`, `read_script` | See your scripts |
| `write_script`, `edit_script` | Change a script. The browser updates live |
| `run_script` | Run or explain a saved script |
| `list_runs`, `get_run` | Look up past runs and their errors |
| `script_variables` | List the variables a script needs |

Agents can only read by default. To let them write, set `"mcp": { "allowWrites": true }` in the config file.

## Run history

Every run is logged for 30 days in `.history/` inside the connection's scripts folder. Each entry has the SQL that was sent, the values used, timings, the first 20 rows of each statement, and the full error if something failed. Agents can read it with `list_runs` and `get_run`.

## Settings

| Environment variable | Default | What it does |
| --- | --- | --- |
| `PSQLEX_PORT` | `7457` | Port to listen on |
| `PSQLEX_CONFIG` | `~/.config/psqlex/config.json` | Connections file |
| `PSQLEX_DATA` | `~/.local/share/psqlex` | Where scripts and history are stored |
| `PSQLEX_HOST` | `127.0.0.1` | Address to listen on. Needs `PSQLEX_TOKEN` if you change it |
| `PSQLEX_TOKEN` | none | Require `Authorization: Bearer <token>` on the API and MCP |

The config file also has these options:

```json
{
  "mcp": { "allowWrites": false, "maxRows": 200 },
  "ui": { "maxRows": 1000, "statementTimeoutMs": 60000 }
}
```

psqlex only accepts requests sent to `localhost`, `127.0.0.1` or `*.localhost`. That stops other websites from talking to it.

## Development

```sh
pnpm install
pnpm dev        # server with reload, plus the UI on http://127.0.0.1:7458
pnpm test       # unit tests, plus database tests if Postgres is running on localhost:5432
pnpm typecheck
pnpm package    # makes release/psqlex-<version>.tar.gz
```
