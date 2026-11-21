# nulls headless client

[RU](README.md) · **EN** · [TR](README.tr.md) · [ZH](README.zh.md)

[![ci](https://github.com/Patrick-9936/nulls-headless-client/actions/workflows/ci.yml/badge.svg)](https://github.com/Patrick-9936/nulls-headless-client/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Patrick-9936/nulls-headless-client)](https://github.com/Patrick-9936/nulls-headless-client/releases)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A headless Node.js client for the **Nulls Brawl 69.252** protocol: accounts, clubs, lobby,
friends, spectating and several concurrent sessions. No game install, no root, no APK
patching — just the network and the protocol.

Unofficial project, not affiliated with Supercell or Nulls. Code is MIT ([`LICENSE`](LICENSE)),
notes about the game and its assets are in [`NOTICE.md`](NOTICE.md).
Requires Node.js 20+ and runs on Windows, Linux, macOS and Android (Termux).

## What it does

| Area | Capabilities |
|---|---|
| Accounts | guest creation, token login, region, device change, file lock against two sessions |
| Clubs | create, join, chat, feed, requests, roles, kick, invitations, settings, top, suggestions |
| Lobby | create a room or join by code, friend/club invites, replies, mode and map, ready state |
| Friends | add by tag, accept, decline, remove, list and online status |
| Battle | matchmaking, cancel, battle load, UDP frames, Brawl TV and player spectating |
| Fleet | run dozens of bots, live commands, pause and resume, per-bot status |
| Interface | interactive menu, CLI, four languages (ru / en / tr / zh), JSON output for scripts |
| Connect | Nulls Connect: PIN by e-mail, bearer token, in-game account binding |

What is verified against a live server and what is not: [`docs/VERIFICATION.md`](docs/VERIFICATION.md)
and `node Program.js features`.

## Quick start

### Single file

Download `Nulls.js` from the [latest release](https://github.com/Patrick-9936/nulls-headless-client/releases/latest):

```sh
node Nulls.js
```

Arrow keys, enter, esc, ctrl+c. On the first run a `.nulls-single-<version>` directory appears
next to the script — keep it, it holds saved logins. Details: [`docs/TUI.md`](docs/TUI.md).

### From git

```sh
git clone https://github.com/Patrick-9936/nulls-headless-client.git
cd nulls-headless-client
npm ci --ignore-scripts
node TUI.js
```

### Termux

Unpack into your **home directory**, not shared Android storage — there are no write
permissions for state files there:

```sh
cd ~ && unzip nulls-headless-client.zip && cd nulls-headless-client
node TUI.js
```

## Documentation

| Document | Contents |
|---|---|
| [`docs/PLATFORMS.md`](docs/PLATFORMS.md) | what works where, Termux limitations |
| [`docs/COMMANDS.md`](docs/COMMANDS.md) | full CLI reference |
| [`docs/FLEET.md`](docs/FLEET.md) | running bot fleets |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | how the client is put together |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | verified against a live server |

The Russian README is the primary one and has the full detail: [`README.md`](README.md).

## License

MIT for the source code. Game assets, APK contents and packet captures are not covered —
see [`NOTICE.md`](NOTICE.md).