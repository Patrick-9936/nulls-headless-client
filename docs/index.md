---
title: nulls headless client
description: Headless Node.js client for the Nulls Brawl protocol — accounts, clubs, lobby, bot fleets, no APK patching.
---

# nulls headless client

**A headless Node.js client for the Nulls Brawl 69.252 protocol.** Accounts, clubs, lobby,
friends, spectating and bot fleets — without installing the game, without root and without
patching the APK. Runs on Windows, Linux, macOS and Android (Termux).

[GitHub](https://github.com/Patrick-9936/nulls-headless-client) ·
[Releases](https://github.com/Patrick-9936/nulls-headless-client/releases/latest) ·
[Документация на русском](https://github.com/Patrick-9936/nulls-headless-client/blob/main/README.md) ·
[English README](https://github.com/Patrick-9936/nulls-headless-client/blob/main/README.en.md)

---

## What it is

The client speaks the game protocol directly: it logs in, joins clubs, opens lobbies, adds
friends, queues for battles and can run a fleet of bots at once. Everything happens over the
network, so the client works on machines that cannot run the game at all — including a phone
in Termux.

| Area | What you get |
|---|---|
| Accounts | guest creation, token login, region, device change, file lock against two sessions |
| Clubs | create, join, chat, feed, requests, roles, kick, invitations, top |
| Lobby | create a room or join by code, invites, replies, mode and map, ready state |
| Friends | add by tag, accept, decline, remove, list, online status |
| Battle | matchmaking, cancel, battle load, UDP frames, Brawl TV, spectating |
| Fleet | dozens of bots, live commands, pause and resume, per-bot status |
| Interface | interactive TUI, CLI, four languages (ru / en / tr / zh), JSON output |

## Quick start

```sh
# single file, dependencies bundled
node Nulls.js

# or from git
git clone https://github.com/Patrick-9936/nulls-headless-client.git
cd nulls-headless-client && npm ci --ignore-scripts && node TUI.js
```

Requires Node.js 20 or newer.

## FAQ

**Do I need root or a modified APK?**
No. The client is a protocol implementation in Node.js; the game is never installed.

**Does it work on Android?**
Yes, in Termux. Unpack into your home directory, not shared storage — Android blocks writes
there. See `docs/PLATFORMS.md` in the repository.

**Which languages are supported?**
The interface ships in Russian, English, Turkish and Chinese; the repository README is
available in all four as well.

**Is it verified against a live server?**
Partially, and honestly documented: `docs/VERIFICATION.md` lists what was checked on a live
server and what was not.

**Is this official?**
No. It is unofficial and not affiliated with Supercell or Nulls. The source code is MIT
licensed; game assets, APK contents and packet captures are not covered by that license —
see `NOTICE.md`.

**Можно ли запустить без установки игры?**
Да, игра не нужна вообще — клиент общается с сервером напрямую. Нужен только Node.js 20+.