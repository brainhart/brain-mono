---
name: repo-conventions
description: Apply repository conventions before coding changes
---

# Repo conventions skill

Use this skill whenever you are asked to modify code in this repository.

## Goals

1. Discover project structure before editing.
2. Follow workspace-specific commands and tooling wrappers.
3. Verify changes with targeted tests or lint checks.

## Steps

1. Read `AGENTS.md` and any relevant workspace README files.
2. Run only pinned tools and recipes (for example `./bin/just ...`).
3. Prefer minimal, focused edits with clear commit messages.
4. Run the narrowest useful verification command.
5. Summarize exactly what changed and what was validated.

## Notes

- Avoid broad destructive actions unless explicitly requested.
- Keep existing user changes intact when working in a dirty tree.
