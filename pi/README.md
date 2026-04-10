# pi workspace

This directory is a dedicated workspace for building and organizing
`pi-coding-agent` resources in a monorepo style.

## Layout

```text
pi/
  packages/
    brain-pi-kit/
      package.json
      extensions/
      skills/
      prompts/
```

Each package can collocate:

- **extensions/** - TypeScript or JavaScript extension modules
- **skills/** - skill directories containing `SKILL.md`
- **prompts/** - markdown prompt templates (for `/name` expansion)

## Why this structure

This mirrors the `pi` package model from `pi-mono` and keeps your
agent customizations close to source control:

- multiple packages over time (`pi/packages/*`)
- each package can be developed, versioned, and shared independently
- resources are grouped together by workflow instead of by file type

## Usage with pi

From this repo root, you can load local resources explicitly:

```bash
pi \
  --extension ./pi/packages/brain-pi-kit/extensions/hello.ts \
  --skill ./pi/packages/brain-pi-kit/skills/repo-conventions \
  --prompt-template ./pi/packages/brain-pi-kit/prompts/review-change.md
```

Or install this package via git once you are ready to share/pin it:

```bash
pi install git:github.com/<you>/<repo>
```

If you eventually want each package to be installable independently from a
single repository, split them into separate repos or publish package tarballs.
