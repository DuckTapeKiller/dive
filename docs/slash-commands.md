# Slash commands

Typing `/name arguments` in the composer forces a specific tool instead of
letting the model decide. Defined in
[`slash_commands.js`](../slash_commands.js).

## The commands

There are 29 entries, most of which are aliases onto the same tool.

| Command                          | Runs                    | Argument                            |
| -------------------------------- | ----------------------- | ----------------------------------- |
| `/db`                            | database-only retrieval | your question                       |
| `/wiki`, `/wikipedia`            | `wikipedia`             | query                               |
| `/britannica`                    | `britannica`            | query                               |
| `/larousse`                      | `larousse`              | query                               |
| `/scholarpedia`                  | `scholarpedia`          | query                               |
| `/book`, `/isbn`, `/book_search` | `book_search`           | title or ISBN                       |
| `/deep_research`                 | `deep_research`         | topic                               |
| `/academic_search`               | `academic_search`       | query                               |
| `/fetch_paper`                   | `fetch_paper`           | URL or DOI                          |
| `/wiktionary`                    | `wiktionary`            | word                                |
| `/etymology`, `/deep_etymology`  | `deep_etymology`        | word                                |
| `/duckduckgo`                    | `duckduckgo`            | query                               |
| `/scrape`, `/web_scraper`        | `web_scraper`           | URL                                 |
| `/calc`, `/calculator`           | `calculator`            | expression                          |
| `/time`, `/time_and_date`        | `time_and_date`         | timezone (optional)                 |
| `/factcheck`, `/fact_check`      | `fact_check`            | claim                               |
| `/notes`, `/local_notes`         | `local_notes`           | action                              |
| `/remember`, `/remember_lesson`  | `remember_lesson`       | the lesson                          |
| `/shell`                         | `shell_command`         | command — **requires confirmation** |

Every command is of type `skill` except `/db`, which is of type `database`.

## `/skill:<name>`

Not a forced tool call. `/skill:<name> text` loads an Agent Skill's
instructions into the message, followed by `User: text`, and the turn then runs
normally with tools available. Only skills enabled for the mode are accepted;
any other name ends the turn with an error. See [skills.md](skills.md).

## `/db` is special

`/db` is not a tool. It forces retrieval from your local library and nothing
else — the answer is grounded in your indexed documents.

Because you asked for the database by name, a failure is treated as a failure.
If retrieval cannot run, `/api/pi` returns **502** rather than answering from
the model's own knowledge, which would be ungrounded and indistinguishable from
a grounded answer. Ambient library context — enabled in settings rather than
requested by name — is best-effort: the turn continues and reports
`libraryError`.

## How a command becomes a call

`parseSlashCommand` matches the leading token; `buildForcedSkillToolCall` maps
the rest of the line onto that tool's arguments. The mapping is per tool —
`/scrape` fills `url`, `/calc` fills `expression`, `/fetch_paper` fills
`url_or_doi`.

A command whose tool is disabled for the active mode returns an error. Commands
do not bypass confirmations: `/shell` still prompts.

Plugin commands are resolved from a **mode-scoped snapshot**, deliberately with
no fallback to the global registry — a plugin installed but not activated for the
calling mode must not be reachable by typing its command.

A plugin command passes the text typed after it to one argument of the plugin
tool's JSON schema: the only required string property when exactly one is
required, otherwise the first string property in declaration order, otherwise a
property named `input`. With nothing typed, the tool gets no arguments, unless
that argument is required, in which case the command is refused. See
[plugins.md](plugins.md#slash-commands).

## The composer launcher

Tools can also appear as buttons above the composer. Enable them per tool, per
mode, in Settings > Tools (the `INPUT` column).

Clicking a button inserts its slash command and focuses the input, leaving you to
type the arguments. It creates no second execution path — submitting goes through
the same parser, validation, confirmations and per-mode configuration as typing
it by hand.

Seventeen tools are eligible:

`wikipedia`, `britannica`, `larousse`, `scholarpedia`, `book_search`,
`deep_research`, `academic_search`, `fetch_paper`, `wiktionary`,
`deep_etymology`, `duckduckgo`, `web_scraper`, `calculator`, `time_and_date`,
`fact_check`, `local_notes`, `remember_lesson`

`shell_command`, `file_operations` and `propose_plugin` are excluded by design —
a one-click button is the wrong affordance for those. The server enforces the
allowlist too, so a crafted settings request cannot add them.

The launcher is per mode and **never appears in Pi**, which has no Dive tools.
The container is repainted on every mode change; without that the previous mode's
buttons simply stayed on screen, including in Pi.
