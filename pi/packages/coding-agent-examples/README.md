# coding-agent-examples

TypeScript examples that use the `@mariozechner/pi-coding-agent` SDK directly (for example session runtime), rather than registering as `pi` extension modules.

Run with your local `pi`/Node setup from the repository root, for example:

```bash
npx tsx pi/packages/coding-agent-examples/sdk/13-session-runtime.ts
```

Adjust the runner and module resolution to match how you invoke SDK scripts in your environment.

## Examples

- **`sdk/13-session-runtime.ts`** — Core session runtime: create, switch, and dispose sessions.
- **`sdk/14-session-workflow.ts`** — Multi-actor workflow orchestration built on session runtime. Translates the `pi-workflow` Go actor model into Pi-native session primitives. See [`SESSION-WORKFLOW-DESIGN.md`](sdk/SESSION-WORKFLOW-DESIGN.md) for the full mapping and rationale.
