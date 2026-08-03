# Dive documentation

Dive is a local-first desktop chat application. An Electron shell starts a Node
HTTP server on `127.0.0.1`, and that server both serves the interface and talks
to whichever model backend you have selected. Conversations, settings, indexed
documents and attachments live in a directory on your machine.

Version 5.0.6.

## Start here

| Document                               | What it covers                                                 |
| -------------------------------------- | -------------------------------------------------------------- |
| [architecture.md](architecture.md)     | The processes, how a message travels, where every module lives |
| [modes.md](modes.md)                   | The five chat modes and exactly how they differ                |
| [data-directory.md](data-directory.md) | Every file Dive writes, and every setting                      |
| [development.md](development.md)       | Running from source, scripts, building, packaging              |

## Reference

| Document                               | What it covers                             |
| -------------------------------------- | ------------------------------------------ |
| [api.md](api.md)                       | Every HTTP endpoint                        |
| [skills.md](skills.md)                 | All 27 built-in skills and their arguments |
| [slash-commands.md](slash-commands.md) | Slash commands and the composer launcher   |
| [pi.md](pi.md)                         | The Pi agent integration                   |
| [library.md](library.md)               | The local document library and retrieval   |
| [mcp.md](mcp.md)                       | Model Context Protocol servers             |
| [plugins.md](plugins.md)               | Writing and installing plugins             |

## Operations

| Document                   | What it covers                                            |
| -------------------------- | --------------------------------------------------------- |
| [security.md](security.md) | The threat model and every control that enforces it       |
| [testing.md](testing.md)   | How this project tests, and the rule every test must pass |

## Conventions used here

Anything stated as fact in these documents was read from the code, not
remembered. Where behaviour is deliberately surprising, the reason is given —
those explanations are usually the useful part.

Where a limit or default is named, the file and constant are named too, so you
can confirm it has not drifted since this was written.
