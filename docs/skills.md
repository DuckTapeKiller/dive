# Skills

Skills are functions the model can call during a turn. Dive ships 27, defined in
[`skills.js`](../skills.js) as `ALL_SKILLS` and implemented across `skills/`.

Skills are available in every mode with `diveSkills: true` — that is, every mode
except Pi, which brings its own tools.

## Reference

Required arguments are in **bold**.

### Research and reference

| Skill             | Arguments                                             | Notes                                |
| ----------------- | ----------------------------------------------------- | ------------------------------------ |
| `wikipedia`       | **query**, language                                   | Article lookup                       |
| `britannica`      | **query**                                             | Independent editorial source         |
| `larousse`        | **query**                                             | French editorial encyclopedia        |
| `scholarpedia`    | **query**                                             | Peer-reviewed specialist articles    |
| `wiktionary`      | **word**, language                                    | Dictionary definitions               |
| `deep_etymology`  | **word**, **language**                                | Origins, cognates, false friends     |
| `book_search`     | **query**, language, provider                         | Books by title or ISBN               |
| `duckduckgo`      | **query**, max_results                                | Quick web search                     |
| `deep_research`   | query, queries, max_sources, academic                 | Full evidence pipeline — see below   |
| `academic_search` | **query**, year_from, year_to, max_results, providers | Scholarly search                     |
| `fetch_paper`     | **url_or_doi**, save                                  | Retrieve a paper, optionally to disk |
| `fact_check`      | **claim**, language                                   | Check a specific claim               |
| `web_scraper`     | **url**                                               | Extract the readable text of a page  |

### Working memory

| Skill             | Arguments                                      | Notes                                     |
| ----------------- | ---------------------------------------------- | ----------------------------------------- |
| `local_notes`     | **action**, content                            | Read and write the notes panel            |
| `remember_lesson` | **lesson**                                     | Append to the calling mode's lessons file |
| `task_plan`       | **action**, steps, plan_id, step, status, note | Multi-step plan tracking                  |

### Utility

| Skill           | Arguments                                                             | Notes                                     |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| `calculator`    | **expression**                                                        | Arithmetic                                |
| `time_and_date` | timezone                                                              | Current time; takes no required arguments |
| `http_request`  | **url**, method, headers, body, timeout_ms, follow_redirects, session | Arbitrary HTTP, SSRF-guarded              |

### Code and system

These are the dangerous ones. See [security.md](security.md).

| Skill             | Arguments                                                           | Notes                            |
| ----------------- | ------------------------------------------------------------------- | -------------------------------- |
| `shell_command`   | **command**, timeout_seconds, cwd                                   | Requires confirmation            |
| `run_code`        | **code**, timeout_ms                                                | JavaScript                       |
| `run_python`      | **code**, timeout_seconds                                           | Python                           |
| `file_operations` | **action**, path, content, pattern                                  | Sandboxed to allowed directories |
| `code_search`     | **action**, path, pattern, glob, start_line, end_line, max_results  | Read-only search                 |
| `git_tools`       | **action**, repo, ref, path_filter, count, start_line, end_line     | Read-only git                    |
| `macos_control`   | **action**, script, target, app, title, message, filter, pid, force | Disabled by default              |

### Extension

| Skill            | Arguments                           | Notes                         |
| ---------------- | ----------------------------------- | ----------------------------- |
| `propose_plugin` | **name**, **description**, **code** | Writes a draft; never runs it |

## Argument handling

Two failure modes are treated very differently, and the distinction matters.

**Arguments that are not valid JSON are refused.** The skill does not run. The
model receives an error naming the skill so it can correct the call. Running with
`{}` would be a guess: the skill either fails somewhere unrelated, or succeeds on
its defaults and answers a question nobody asked — and the user is told neither.

**Valid JSON that omits a field is left alone.** Models omit schema-required
fields constantly. `deep_etymology` declares `language` as required and defaults
it to English precisely because of that. Skills that care supply their own
defaults or return their own validation message. Enforcing declared schemas
generically would turn working calls into errors.

Empty or absent arguments are fine — that is how a no-argument skill like
`time_and_date` gets called.

## Enabling and disabling

Per mode, through `/api/ollama/skills/settings?mode=<mode>`. A disabled skill
returns an error if called rather than executing.

A subset can also be surfaced as buttons in the composer — see
[slash-commands.md](slash-commands.md). The allowlist for that deliberately
excludes `shell_command`, `file_operations` and `propose_plugin`.

## deep_research

The largest skill by far, and not simply a bigger web search. It runs an evidence
pipeline:

1. **Orientation** — establish the subject, using Wikipedia, Britannica,
   Larousse, Scholarpedia, or Store norske leksikon.
2. **Angles** — several distinct research directions rather than one query.
3. **Discovery** — web and scholarly search, independently.
4. **Ranking** — authority, title and context matches, source type.
5. **Validation** — reject what is not evidence.
6. **Reading** — fetch the surviving candidates concurrently.
7. **Deduplication** — collapse syndicated copies.
8. **Diversity** — prefer distinct domains over repeats of one.
9. **Dossier** — a structured brief for the model.

### What it refuses

CAPTCHA and bot-protection pages, raw HTML returned as article text, empty or
very short pages, error payloads, paywalls and login walls, duplicated or
syndicated evidence, and Grokipedia (blocked by host label on every fetch
helper, so subdomains and mirrors cannot slip through).

It does not pad an answer with weak sources. Fewer verified sources beat an
inflated count.

### Authority scoring

Domains are matched by **suffix**, never substring. This is not pedantry:
substring matching gave `nih.gov.evil-mirror.com` exactly the same authority as
`nih.gov`, and `cheap-university-essays.biz` the authority of an institution.
Since authority decides what gets read and cited, a registered look-alike could
walk into the dossier. `test/research_quality.test.js` pins this.

### Archive recovery

Unreachable pages are retried through the Wayback Machine, then archive.ph.
Archived evidence is labelled with the service, archived URL, original URL and
capture date, and is treated as historical rather than current.

### Disambiguation

When several people or topics match, the model is asked to emit exactly:

```markdown
## Possible matches

- **Exact candidate name** — short identifying descriptor
```

The interface turns **only the bolded name** into a clickable button; the
descriptor stays as text. Clicking runs `/deep_research <name>` through the
normal slash-command path. Parsing is scoped to a recognised heading followed
directly by a list, and the name must open its list item — a bold run used
mid-sentence is not a candidate.

## Writing your own

Two routes: custom skills through `/api/custom-skills`, or a plugin. See
[plugins.md](plugins.md).
