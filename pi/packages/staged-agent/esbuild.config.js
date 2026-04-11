import * as esbuild from "esbuild";
import { chmod, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, "bin");
const bundlePath = join(binDir, "staged-agent.mjs");
const wrapperPath = join(binDir, "staged-agent");

await esbuild.build({
	entryPoints: [join(__dirname, "src", "cli.ts")],
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	outfile: bundlePath,
	sourcemap: false,
	minify: false,
	external: [
		"@mariozechner/pi-coding-agent",
		"@mariozechner/pi-tui",
		"@mariozechner/pi-ai",
		// Native addon loaded at runtime via optional require() —
		// only needed on Windows for Shift+Tab detection.
		"koffi",
	],
});

const wrapper = `#!/bin/sh
# Thin wrapper so "staged-agent" works without an extension in PATH.
exec node "$(dirname "$0")/staged-agent.mjs" "$@"
`;
await writeFile(wrapperPath, wrapper);
await chmod(wrapperPath, 0o755);
await chmod(bundlePath, 0o755);

const { size } = await stat(bundlePath);
console.log(
	`wrote ${bundlePath} (${(size / 1024).toFixed(0)} KiB)`,
);
console.log(`wrote ${wrapperPath} (shell wrapper)`);
