# SDD — spec-driven development

The durable spec. One file, `SPEC.md`, at the project root, holding goals,
constraints, interfaces, invariants, tasks and bugs in a format dense enough
that an agent can re-read the whole thing on every request.

Origin: the format is [cavekit](https://github.com/JuliusBrussee/cavekit)'s
(`FORMAT.md` there, now frozen), minus the caveman persona and the slash-command
ceremony. What is added here is the part cavekit leaves implicit: a **maintenance
protocol** for what happens when a new requirement invalidates an old one, which
is the failure mode every long-lived spec dies of.

## Why

An agent's context window resets. The code survives, the conversation does not —
so everything that was decided but not written down gets re-derived next session,
usually differently, and often wrongly. Plan-then-execute forgets. Comments rot
in place. Git history records *what changed*, never *what must stay true*.

`SPEC.md` is the long-term memory: lose the window, reload the spec, keep going.
It earns its tokens three ways, and if it stops doing all three it is bloat:

- **It is durable.** It survives context resets, model switches, and the six
  months between one session in a project and the next.
- **It is cheap.** Compressed encoding costs ~25% of the prose it replaces, so
  reading it on every request is affordable. A spec too expensive to reload is
  not a spec, it is documentation.
- **It backpropagates.** Every bug becomes a `§B` row, and the class of bug
  becomes a `§V` invariant. The project stops re-making mistakes it has already
  made once. This is the property plan-then-execute cannot have.

## The file

One file. Project root. Fixed section order, fixed headers, addressable ids. A
section may be absent — `§R` only exists if research was done — but never moves.

Big project → more sections, not more files. Splitting across files means an
agent greps instead of reads, and grep ceremony is exactly the cost this format
exists to avoid.

```
# SPEC

## §G GOAL          one line. what the code must do.
## §C CONSTRAINTS   bullets. non-negotiable boundaries — stack, ports, deps, paths.
## §I INTERFACES    the external surface. routes, CLI, config, env, file formats.
## §R RESEARCH      optional pipe table. external facts + sources, so nothing is re-derived.
## §V INVARIANTS    numbered. testable. each one MUST hold.
## §T TASKS         pipe table. `x` done / `~` wip / `.` todo. cites the §V it serves.
## §B BUGS          pipe table. every bug that got out, and the invariant that now catches it.
```

### §G — goal

One line. What the code must do, not how. If it takes a paragraph, the project
has two goals and wants two specs — or the second one is really a `§C`.

> path-routed reverse proxy + landing page. one local port → multi-project hub.

### §C — constraints

Non-negotiable boundaries: runtime floors, locked dependency versions, bind
addresses, port assignments, path conventions, "must not" rules. Unnumbered
bullets, edited in place.

> - Node ≥ 22 (marked v18 ESM-only). single process, no framework.
> - bind `127.0.0.1` only. external reach via Tailscale.
> - proxy port 8002 (env `PROXY_PORT` overrides).

`§C` is the section that goes stale first and complains least — see Maintenance.

### §I — interfaces

Everything outside the project can touch: HTTP routes and their exact response
shapes, CLI invocations, env vars, config file schemas, on-disk formats, the
event names a plugin emits. Shapes, verbatim.

> - `GET /api/projects` → `{projects: [{name, title, description, tags, openUrl}]}`
> - `POST /api/projects` body `{name, template?}` → `{name, termUrl, browseUrl}`
> - env: `PROJECTS_ROOT` ? — defaults `~/projects`

If a caller depends on it, it belongs here. If only the module itself sees it,
it does not.

### §R — research (optional)

External knowledge, with sources, so a build grounds in fact instead of a
plausible hallucination about a library's behavior. Present only if research was
actually done.

```
id|topic|finding|src
R1|jwt lib|`jose` > `jsonwebtoken` — maintained, ESM, 0 deps|github.com/panva/jose
```

Every row cites a source. A finding you could not verify still gets a row —
flagged `?` — because an honestly-labeled unknown is useful and a guess dressed
as fact is a future `§B`.

### §V — invariants

The heart of the file. Numbered, testable rules that must hold. Each one is a
thing the code can be checked against — by a test, by a grep, by reading one
named file.

> V13: every create path ends w/ `sudo systemctl enable --now ttyd@<name>.service`.
> V29: pre-existing `AGENTS.md` / `README.md` are NEVER overwritten on clone.

A good invariant is:

- **Testable** — a named test asserts it, or a grep settles it. An invariant
  nobody can check is decoration.
- **Scoped to a behavior, not a file.** "auth checked before every handler",
  not "`mw.go` has a check". Files move; behaviors are the contract.
- **Stated positively where possible** — `! hold` reads better than `⊥ forbid`.
- **Carrying its own refutation** when one exists. The most expensive fact in an
  invariant is usually *why the obvious alternative is wrong* — record it with
  `⊥ <the rejected approach>`. That clause is what stops a future agent
  "simplifying" the line back into the bug it came from.

### §T — tasks

```
id|status|task|cites
T3|x|add auth middleware|V1,I.api
T4|.|impl §I.api POST /x|V2
```

Status `x` done, `~` in progress, `.` todo. `cites` names the `§V`/`§I` the task
serves, so finished work is traceable back to the rule it was there to satisfy.

### §B — bugs

```
id|date|cause|fix
B1|2026-04-20|token `<` not `≤` ∴ rejected @ expiry|V2
```

Every bug that reached a human gets a row — including ones that produced no new
invariant, because the row itself is the record that this failure mode was
considered. `fix` cites the `§V` that now catches the class, or `-` if there
isn't one.

## Encoding

The spec is read on every request, so it is written compressed. Roughly 75%
fewer tokens than the equivalent prose, and a human skims it faster too.

- Drop articles, filler, hedging, and auxiliary verbs where a fragment works.
- Fragments are fine. Short synonyms win (`fix` > `implement`).
- **Preserve verbatim**: code, paths, identifiers, URLs, numbers, versions,
  error strings, SQL, regex, quoted strings. Compression is not amputation — if
  cutting a word loses a fact, keep the word.

| sym | means | | sym | means |
|---|---|---|---|---|
| `→` | leads to / becomes / on | | `!` | must / required |
| `∴` | therefore | | `?` | may / optional / unknown |
| `∀` | for all / every | | `⊥` | never / forbidden / the rejected alternative |
| `∃` | exists / some | | `≠` | not equal |
| `∈` `∉` | in / not in | | `≤` `≥` | at most / at least |
| `&` `\|` | and / or | | `§` | section reference |

Prose in, caveman out:

> ~~The authentication middleware must verify token expiry on every request
> before allowing the handler to execute.~~
>
> `V1: ∀ req → auth check before handler`

This encoding applies to `SPEC.md` and nothing else. Commit messages, code
comments, PR descriptions and anything a stranger reads stay normal English.

## Addressing

`§<S>.<n>` — `§V.2` is the second invariant, `§I.api` the api item, `§T.14` a
task. Commits, tests, comments and bug rows all reference by address, so there
is exactly one name for each rule.

Test names cite invariants: a test called `V63: ttyd reconnects at the right
size` is greppable from the spec line and vice versa. That two-way link is what
keeps invariants from quietly losing their proof.

## The loop

1. **Read `SPEC.md`.** Whole file, start of the work.
2. **Work.** Every change traces to a `§T` row, and respects every `§V` it
   touches. Flip the row `.` → `~` when you start.
3. **Verify against an external oracle** — the test suite, the linter, the
   running app. Not "looks done". Each `§V` touched has a named test that proves
   it; a new invariant with no test is a lie.
4. **Backprop** anything that broke (below).
5. **Update the spec in the same turn as the code.** New surface → `§I`. New
   rule → `§V`. Row done → `x`. A spec updated "later" is a spec that drifts.
6. **Commit** code + spec + tests together.

### Backprop — bug → spec

The one thing SDD does that plan-then-execute does not: fix the code *and* edit
the spec so the class of failure cannot come back.

1. **Trace.** Find the exact `file:line` of the wrong behavior. Name the root
   cause in one line.
2. **Ask three questions.** Would a new `§V` catch this class? (usually yes) Is
   `§I` wrong — did the spec promise a shape the code cannot deliver?
   (sometimes) Is `§T` wrong — did we build the wrong thing? (rare, real)
3. **Write the failing test first**, named for the invariant it proves.
4. **Fix. Run it. Run everything** — a fix that regresses another `§V` is not a fix.
5. **Append the `§B` row**, and the `§V` line if there is a class to catch.
6. **Commit** spec + test + fix together.

Skip the new `§V` when the bug was a mechanical typo with no class, a one-time
migration, or an upstream dependency's fault (note that in `§C` and upgrade
instead). Never skip the `§B` row.

## Maintenance — keeping the spec true as it grows

A spec dies one of two deaths: it bloats until nobody reloads it, or it drifts
until nobody trusts it. Both are the same root cause — **new requirements
arriving without anyone retiring the old ones they invalidated**. Adding is easy
and feels productive; invalidating is silent and never announces itself.

### The rule that makes the rest work

**`§V` and `§I` describe the present. `§T` and `§B` are logs.**

That single distinction settles every maintenance question. Present-tense
sections get *edited* — an invariant that no longer matches the code is worse
than no invariant, because it will be believed. Log sections only get *appended*,
and are only ever trimmed oldest-first.

**Numbers are permanent addresses, never positions.** Ids are monotonic and
never reused, because `§B` rows and test names cite them; handing `V12` to a new
rule silently rewrites the history of every citation. The highest id in the file
is the watermark, even for ids no longer present.

### The three moves

When a new requirement meets an existing one, exactly one of these applies:

**REVISE** — the concern survives, the rule changed. Rewrite the line *at its
existing number*, tag it `(revised)`, and keep the superseded rule as an explicit
`⊥ <old rule>` clause whenever a future agent could plausibly re-derive it. Two
reasons the old rule stays: the `§B` rows citing this number must still parse,
and the discarded approach is a trap someone will otherwise walk back into.

> `V58` was "split iff `(min-width: 900px) and (orientation: landscape)`". The
> soft keyboard shrinks the layout viewport, and `orientation` is a
> layout-viewport feature, so a portrait tablet flipped to "landscape" every time
> the keyboard opened (`B22`). The replacement did **not** take a fresh number
> at the bottom of `§V` — it became `V58 (revised)`, carrying `⊥ the live media
> query it replaced` and the reason why. Same address, new rule, old trap kept.

**RETIRE** — the concern is gone: the feature was deleted, the dependency
dropped, the surface removed. Delete the line. Its number is retired forever.
Log the retirement in the `§T` row that did the work:

```
T90|x|drop the FOO pane; retires V12, V13|-
```

That is the entire record. `grep V12 SPEC.md` finds the task that killed it, at
zero standing cost — no tombstone list to maintain, and git has the text.

**MERGE** — two lines say the same thing from different angles, usually because
they were written months apart. Fold them into the lowest-numbered one and leave
a one-line pointer at the address you emptied, so every existing citation still
resolves:

```
V30: (merged into V31).
```

That pointer is worth its one line in a way a retirement tombstone is not: a
merge keeps the *concern*, so `§B` rows and test names citing `V30` are still
about something real and must lead somewhere. Two invariants governing one
behavior always drift apart, and then the code satisfies neither — merge on
sight.

### How you notice

Invalidation is silent. These are the moments it becomes visible — none of them
are "remember to keep the spec tidy":

- **Before appending a `§V`, grep `§V` for its subject.** This is the dominant
  failure: appending a new invariant that quietly contradicts one written a
  year earlier, and leaving both standing. If a line on that subject already
  exists, decide *revise or add* — never both.
- **A `§B` whose root cause is "the code did exactly what `§V` said"** is a
  revise, not a new invariant. Spec right, code wrong → new `§V` or none. Spec
  wrong → revise the `§V`, and say so in the `§B` row's `fix` cell.
- **Touching a dep, port, runtime floor, or path convention → re-read `§C` in
  the same turn.** `§C` has no numbers and no citations, so nothing makes a stale
  constraint noisy. It is the section most likely to be lying right now.
- **Drift sweep** — periodically, and always before a release or a big refactor,
  read `§V`/`§I` against the code and classify each line:
  - **HOLD** — verified, cite the `file:line` or test that proves it.
  - **VIOLATE** — the code disagrees. Now decide, and this is the judgment the
    whole protocol exists for: *is this a bug, or an invariant the project
    outgrew?* Bug → backprop. Outgrown → revise or retire.
  - **STALE** — describes something that no longer exists → retire.
  - **UNVERIFIABLE** — no test and no grep can settle it → sharpen it until one
    can, or retire it. An invariant nobody can check is not being maintained.

### Size budget

Target: the whole file readable in one sitting. Past ~500 lines, compact — as a
deliberate, reviewed edit, never as a side effect of another change:

1. **`§T` rows whose substance now lives in `§V`/`§I`.** The task log is
   scaffolding for work in flight; once the rule it produced is recorded, the row
   is history.
2. **Oldest `§B` rows** — keeping any whose failure mode can still recur.

**Never compact `§V` or `§I` by dropping lines — only by merging.** Dropping a
live invariant to save tokens is how a fixed bug comes back.

Two things are never pruned at any size: a `§B` row whose failure mode can still
recur, and a `§V` that is the only surviving record of why the obvious approach
does not work.

## Right-sizing

Ceremony scales to blast radius, never to habit. A one-line fix is just a fix —
writing a `§T` row for a typo costs more attention than the typo. Reach for the
full loop when the change is genuinely uncertain or high blast radius: a shared
module, auth, data, money, a public `§I`. Skip any step that would cost more
than the change is worth, and skip it deliberately rather than by drifting.

The spec is the only artifact here that earns its tokens by default. Everything
else must either save more tokens later, or save the user's attention, or go.
