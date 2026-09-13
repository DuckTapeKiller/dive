# Skills

Skills are folders with a `SKILL.md` file, the
[open format](https://agentskills.io) that Claude Code, pi and other agents use.
They hold instructions, not code: Dive never runs anything in them by itself. A
skill tells the model how to do a task; the actions it asks for are done with
tools, documented in [tools.md](tools.md).

Defined in [`agent-skills.js`](../agent-skills.js). Every mode except Pi uses
them; Pi mode loads pi's own skills. They are managed in Settings > Skills.

## Where Dive looks

| Folder              | Notes                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| `~/dive/skills/`    | Dive's own folder                                                                       |
| `~/.agents/skills/` | The cross-client folder, which pi also reads                                            |
| Extra folders       | Added in Settings > Skills and stored in `skill-paths.json`, such as `~/.claude/skills` |

A skill folder may sit inside grouping folders up to five levels deep. Symlinks
are followed, so one copy of a skill can serve every agent. `.git`,
`node_modules` and hidden folders are skipped. An extra folder may also be a
single skill folder. When two skills share a name, the first folder in the
table wins and the other is reported as not loaded.

## Parsing

The frontmatter is parsed with `yaml`, the library pi uses. Following the
[integration guide](https://agentskills.io/integrate-skills), problems that
other clients tolerate are warnings and the skill still loads: a name that
breaks the naming rules or does not match its folder, a description over 1024
characters, unquoted values that contain colons. A skill is skipped, with the
reason shown in Settings, when its description is missing, its frontmatter
cannot be parsed, or its name contains spaces or colons.
`disable-model-invocation: true` keeps a skill out of the model's list, but
`/skill:<name>` still works.

## How the model uses them

Enabled skills are listed by name and description in the system prompt, and
the model gets one extra tool:

| Tool             | Arguments                | Notes                                                                                                |
| ---------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `activate_skill` | **name**, `file`, `part` | Returns the `SKILL.md` body without frontmatter, the skill folder and its bundled files, or one file |

`file` must be a relative path inside the skill folder. Paths that climb out of
it, symlinks that point outside it, binary files and files over 2 MB are
refused. Content over 100,000 characters is split into parts at line breaks, and
the result says how to ask for the next part.

The tool and the list are offered only when at least one skill is enabled for
the mode, and never on Database Context turns. A skill's body is read on each
activation, so an edit applies to the next message; the list is rescanned at
most every two seconds.

## Typing /skill:name

`/skill:<name> your text` puts the skill's instructions into the message,
followed by `User: your text`, as pi does. Earlier `/skill:` turns are expanded
again on every request, so follow-up messages keep the instructions; the saved
conversation keeps what you typed. An unknown or disabled name ends the turn
with an error. See [slash-commands.md](slash-commands.md).

## Enabling and disabling

Each skill has a switch per mode in Settings > Skills, saved in that mode's
settings as `skill:<name>`. New skills start enabled.
