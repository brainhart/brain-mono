# brain-pi-kit

This package collocates your `pi` customizations in one place:

- `extensions/` for TypeScript runtime behavior (the package manifest loads `hello.ts` by default; other `.ts` files in this folder are upstream-style samples—pass them with `--extension` when you want to load one)
- `skills/` for task-specific operating instructions
- `prompts/` for reusable prompt templates

## Local development

Run pi and point it at local resources while iterating:

```bash
pi \
  --extension ./pi/packages/brain-pi-kit/extensions/hello.ts \
  --skill ./pi/packages/brain-pi-kit/skills/repo-conventions \
  --prompt-template ./pi/packages/brain-pi-kit/prompts/review-change.md
```

## Package metadata

This package includes a `pi` manifest in `package.json`, so pi can discover
resources when installed from npm or git.
