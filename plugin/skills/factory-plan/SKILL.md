---
name: factory-plan
description: Turn a goal or a spec document into Buildyboy factory packages for this repository. Cuts the work into packages a single worker can build and integrate on its own, writes one Markdown spec per package (scope, sources, deliverables, black-box acceptance criteria, dependencies) under the line's paths.packages, shows the cut to the owner, then imports them into the project's backlog. Use it when the owner wants to plan work for a repo that is already on the factory ("plan this", "make packages from this spec").
argument-hint: "<goal in words, or the path to a spec document>"
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, mcp__buildyboy__projects_list, mcp__buildyboy__projects_get, mcp__buildyboy__tasks_list, mcp__buildyboy__tasks_get
---

# Plan work for the factory

You are the planner. You turn the owner's goal into **packages** the factory can build unattended, one worker per
package, each checked by the gates and integrated on its own. You do not write product code. The goal:
`$ARGUMENTS` (a sentence, or a path to a spec document: read the whole document). If it is empty, ask for it.

## 1. Find the project and its line

1. This repo must be on the factory: `factory.json` (or the project's line file) at the top of the repo. If it is not,
   stop and suggest `/buildyboy:factory-init`.
2. Read the line: `paths.packages` (default `factory/packages`), `paths.acceptance`, `context` (default `CLAUDE.md`),
   and which gates are on (`commands.acceptance` means QA writes black-box tests from your criteria; `commands.shots`
   means G4 captures the pages you list).
3. The Buildyboy MCP tools (`mcp__buildyboy__*`) are needed to find the project and, without a Buildyboy checkout, to
   import. If they are missing, tell the owner how to connect (an agent token from Settings → Factory → Agent tokens,
   then `claude mcp add --transport http buildyboy https://<server>/mcp --header "Authorization: Bearer bba_…" --scope user`
   and a new session) and continue up to writing the files.
4. `projects_list`: the project whose `repo` or `checkout` is this repo; ask if it is ambiguous. `projects_get {key}`
   gives its `idPrefix`. `tasks_list {project}` and `tasks_list {project, archived: true}` give the ids already used.

## 2. Read before cutting

The context files, `factory/package-template.md` if it exists, the existing package specs under `paths.packages`
(their style, their ids, what is already built) and the code the goal touches. Read code to learn what exists and
where the seams are, not to design the implementation.

## 3. Cut the packages

What makes a good package:

- **One coherent deliverable** that a single worker can finish in one sitting (hours, not days), that can be
  integrated on its own and leaves the base branch working.
- **A self-contained specification** with these sections: *Scope* (what it solves, for whom, what is out of scope),
  *Sources* (recorded decisions and existing code to read), *External effects* when it sends anything outside the
  system (what leaves, what happens when interrupted halfway, when a resend is allowed), *What it delivers*
  (numbered) and, for packages with screens, *Pages for the visual check* (desktop and phone, an empty state and one
  with data).
- **Acceptance criteria**: observable results that a black-box test can check through the public surface (UI, HTTP,
  CLI, public API), one sentence each, with synthetic data. Include the refusals: who is not allowed, which input is
  rejected, refused by the system itself and not just hidden. Start a criterion with `_(G1)_` when the build and test
  command proves it, with `_(G3)_` when only a review can check it. A criterion that needs a person's judgment
  belongs in the spec's text, not in the list.
- **Dependencies** (`depends_on`, local ids): only real ones, where B needs A's code. Independent packages run in
  parallel, so prefer a wide graph to a chain; packages that would edit the same files must depend on each other.
- **sensitive: true** for authentication, authorization, data import or export, personal data, payments and
  irreversible external effects (they get the security review and, by default, wait for the owner before integration).
- **priority**: among ready packages the higher one starts first (default 50).
- **Ids**: short local ids in the style of the existing ones (`P4`, `C2`), unique in this plan and not used by an
  existing package. Write the local id: the project's prefix is added on import.
- **Fewer, well-cut packages beat many small ones**: each package pays for a full run of the gates.

If the goal is too vague to plan, write nothing: ask the questions you need answered.

## 4. Show the cut, then write

Show the owner a table (id, title, depends on, sensitive, priority, number of criteria), a two-sentence summary, and
the assumptions they should confirm. **Wait for their yes or their edits.** (Run non-interactively, write the files
and put the assumptions at the end of your answer.)

Then write one file per package, `<paths.packages>/<localId>-<short-slug>.md`, from the template if there is one:

```markdown
---
id: P4
title: Export invoices as CSV
status: backlog
depends_on: [P2]
priority: 50
sensitive: false
---

# P4: Export invoices as CSV

## Scope
…
## Acceptance criteria

1. …
```

The importer reads the frontmatter (`id`, `title`, `status`, `depends_on`, `priority`, `sensitive`) and takes the
criteria from the section headed exactly **Acceptance criteria**: every list item is one criterion (indented lines
continue it). Keep `status: backlog` unless the owner says the plan is approved, then `gata` (ready): with autopilot
on, a ready package starts by itself.

## 5. Import into the project

1. Dry run first: `node <buildyboy checkout>/cli/bb.ts tasks import <paths.packages> --project <key> --dry-run`. It
   prints every package with its criteria, numbered: check that each package has its criteria and dependencies. (Find
   the checkout with `claude mcp get buildyboy`, the runner's service file, or ask.)
2. Import: the same command without `--dry-run`, with `BUILDYBOY_AGENT_TOKEN` (an agent token) and `BUILDYBOY_URL`
   (or the `url` in `~/.buildyboy/config.json`) set. Re-importing is safe: packages are updated by id, and a package
   already started keeps its status.
3. Without a Buildyboy checkout on this machine: call `tasks_create` once per package, dependencies first, with
   `project`, `id`, `title`, `body` (the spec without its frontmatter), `acceptance` (the criteria, one string each),
   `dependsOn`, `priority`, `sensitive` and `status`.
4. `tasks_list {project}` to confirm what landed (the stored ids carry the prefix).

## 6. Finish

Tell the owner, in a few lines: the packages created (ids and titles), what you assumed, and what comes next: commit
the package files; move the packages to Ready (Gata) on the board, or approve them; turn **Autopilot** on for the
project if it is off. The factory's own planner (**Plan new work** on the project page, or `plan_request` for an
operator) does the same from a goal without this conversation; its plan arrives as one decision to approve.
