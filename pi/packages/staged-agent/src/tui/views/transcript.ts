/**
 * Transcript viewer for a completed or running task's Pi session.
 *
 * Uses the same core interactive-mode message components from
 * `@mariozechner/pi-coding-agent` so the task drill-down mirrors Pi's
 * user/assistant/tool rendering model as closely as possible.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { Container, Spacer, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	type ToolExecutionOptions,
	getMarkdownTheme,
	initTheme,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@mariozechner/pi-coding-agent";
import {
	colored, horizontalRule,
	FG_CYAN, FG_GRAY, FG_RED, FG_WHITE, BOLD, DIM,
} from "../helpers.js";
import { parseNavKey, KeyState, clampScroll, renderFooter } from "../keybindings.js";

export type TranscriptEntry = AgentMessage;
export type TranscriptData = {
	entries: TranscriptEntry[];
	cwd?: string;
};

export type TranscriptRenderOptions = {
	cwd?: string;
	showImages?: boolean;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	expandToolOutput?: boolean;
};

type BashExecutionMessage = AgentMessage & {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
};

type CustomDisplayMessage = AgentMessage & {
	role: "custom";
	customType: string;
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	display: boolean;
	details?: unknown;
};

type BranchSummaryMessage = AgentMessage & {
	role: "branchSummary";
	summary: string;
	fromId: string;
};

type CompactionSummaryMessage = AgentMessage & {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
};

let themeInitialized = false;

function ensureInteractiveTheme(): void {
	if (themeInitialized) return;
	initTheme(undefined, false);
	themeInitialized = true;
}

function getUserMessageText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((content): content is { type: "text"; text: string } =>
			content.type === "text" && typeof content.text === "string",
		)
		.map((content) => content.text)
		.join("\n");
}

function toolFailureMessage(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "aborted" && message.stopReason !== "error") return undefined;
	return message.stopReason === "aborted"
		? "Operation aborted"
		: message.errorMessage || "Error";
}

export type TranscriptViewAction =
	| { type: "back" }
	| { type: "help" }
	| { type: "quit" };

export function renderTranscriptEntries(
	entries: TranscriptEntry[],
	width: number,
	opts?: TranscriptRenderOptions,
): string[] {
	ensureInteractiveTheme();
	const markdownTheme = getMarkdownTheme();
	const container = new Container();
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const ui = { requestRender() {} } as unknown as TUI;
	const cwd = opts?.cwd ?? process.cwd();
	const toolOptions: ToolExecutionOptions = {
		showImages: opts?.showImages ?? true,
	};
	const expandToolOutput = opts?.expandToolOutput ?? false;
	const hideThinkingBlock = opts?.hideThinkingBlock ?? false;
	const hiddenThinkingLabel = opts?.hiddenThinkingLabel ?? "Thinking...";

	const addMessageToChat = (message: TranscriptEntry): void => {
		switch (message.role) {
			case "bashExecution": {
				const bashMessage = message as BashExecutionMessage;
				const component = new BashExecutionComponent(
					bashMessage.command,
					ui,
					bashMessage.excludeFromContext,
				);
				component.setExpanded(expandToolOutput);
				if (bashMessage.output) {
					component.appendOutput(bashMessage.output);
				}
				component.setComplete(
					bashMessage.exitCode,
					bashMessage.cancelled,
					undefined,
					bashMessage.fullOutputPath,
				);
				container.addChild(component);
				break;
			}
			case "custom": {
				const customMessage = message as CustomDisplayMessage;
				if (!customMessage.display) break;
				const component = new CustomMessageComponent(customMessage, undefined, markdownTheme);
				component.setExpanded(true);
				container.addChild(component);
				break;
			}
			case "compactionSummary": {
				container.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(
					message as CompactionSummaryMessage,
					markdownTheme,
				);
				component.setExpanded(true);
				container.addChild(component);
				break;
			}
			case "branchSummary": {
				container.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(
					message as BranchSummaryMessage,
					markdownTheme,
				);
				component.setExpanded(true);
				container.addChild(component);
				break;
			}
			case "user": {
				const textContent = getUserMessageText(message as UserMessage);
				if (!textContent.trim()) break;
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					container.addChild(new Spacer(1));
					const component = new SkillInvocationMessageComponent(skillBlock, markdownTheme);
					component.setExpanded(true);
					container.addChild(component);
					if (skillBlock.userMessage) {
						container.addChild(new UserMessageComponent(skillBlock.userMessage, markdownTheme));
					}
				} else {
					container.addChild(new UserMessageComponent(textContent, markdownTheme));
				}
				break;
			}
			case "assistant": {
				container.addChild(new AssistantMessageComponent(
					message as AssistantMessage,
					hideThinkingBlock,
					markdownTheme,
					hiddenThinkingLabel,
				));
				break;
			}
			case "toolResult":
				// Matched to preceding tool call component below.
				break;
			default:
				break;
		}
	};

	for (const message of entries) {
		if (message.role === "assistant") {
			const assistantMessage = message as AssistantMessage;
			addMessageToChat(assistantMessage);
			for (const content of assistantMessage.content) {
				if (content.type !== "toolCall") continue;
				const component = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					toolOptions,
					undefined,
					ui,
					cwd,
				);
				component.setExpanded(expandToolOutput);
				container.addChild(component);
				const failure = toolFailureMessage(assistantMessage);
				if (failure) {
					component.updateResult({
						content: [{ type: "text", text: failure }],
						isError: true,
					});
				} else {
					pendingTools.set(content.id, component);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const resultMessage = message as ToolResultMessage;
			const component = pendingTools.get(resultMessage.toolCallId);
			if (component) {
				component.updateResult(resultMessage);
				pendingTools.delete(resultMessage.toolCallId);
				continue;
			}
			const orphanedComponent = new ToolExecutionComponent(
				resultMessage.toolName,
				resultMessage.toolCallId,
				{},
				toolOptions,
				undefined,
				ui,
				cwd,
			);
			orphanedComponent.setExpanded(expandToolOutput);
			orphanedComponent.updateResult(resultMessage);
			container.addChild(orphanedComponent);
			continue;
		}
		addMessageToChat(message);
	}

	return container.render(width);
}

export function parseTranscript(
	entries: unknown[],
	_opts?: { cwd?: string },
): TranscriptEntry[] {
	const result: TranscriptEntry[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type === "message" && record.message && typeof record.message === "object") {
			result.push(record.message as TranscriptEntry);
		}
	}
	return result;
}

export class TranscriptView implements Component {
	private entries: TranscriptEntry[] = [];
	private cwd: string | undefined;
	private renderOptions: TranscriptRenderOptions | undefined;
	private scrollOffset = 0;
	private contentHeight = 0;
	private readonly keyState = new KeyState();
	private taskId: string;
	private sessionId: string;
	private loading = false;
	private error: string | undefined;
	private expandToolOutput = false;
	onAction: ((action: TranscriptViewAction) => void) | undefined;

	constructor(taskId: string, sessionId: string) {
		this.taskId = taskId;
		this.sessionId = sessionId;
	}

	setEntries(entries: TranscriptEntry[], cwd?: string): void {
		const wasAtBottom = this.isAtBottom();
		this.entries = entries;
		this.cwd = cwd;
		this.loading = false;
		if (wasAtBottom) this.pinToBottom();
	}

	setRenderOptions(options: TranscriptRenderOptions | undefined): void {
		this.renderOptions = options;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
	}

	setError(error: string): void {
		this.error = error;
		this.loading = false;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+o")) {
			const wasAtBottom = this.isAtBottom();
			this.expandToolOutput = !this.expandToolOutput;
			if (wasAtBottom) this.pinToBottom();
			return;
		}
		const nav = parseNavKey(data, this.keyState);
		if (!nav) return;
		switch (nav.type) {
			case "up":   this.scrollOffset = clampScroll(this.scrollOffset - 3, this.contentHeight); return;
			case "down": this.scrollOffset = clampScroll(this.scrollOffset + 3, this.contentHeight); return;
			case "top":  this.scrollOffset = 0; return;
			case "bottom": this.pinToBottom(); return;
			case "half_page_up":   this.scrollOffset = clampScroll(this.scrollOffset - 20, this.contentHeight); return;
			case "half_page_down": this.scrollOffset = clampScroll(this.scrollOffset + 20, this.contentHeight); return;
			case "back":  this.onAction?.({ type: "back" }); return;
			case "help":  this.onAction?.({ type: "help" }); return;
			case "quit":  this.onAction?.({ type: "quit" }); return;
			case "enter": return;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];

		lines.push(colored(` Transcript: ${this.taskId}`, FG_GRAY, DIM));
		lines.push(horizontalRule(width));
		lines.push(
			colored(" Session transcript", BOLD, FG_WHITE)
			+ colored(`  ${this.sessionId}`, FG_GRAY, DIM),
		);
		lines.push(horizontalRule(width));
		lines.push("");

		if (this.loading) {
			lines.push(colored("  Loading transcript…", FG_CYAN));
			lines.push("");
		} else if (this.error) {
			lines.push(colored(`  Error: ${this.error}`, FG_RED));
			lines.push("");
		} else if (this.entries.length === 0) {
			lines.push(colored("  No transcript entries found", FG_GRAY));
			lines.push("");
		} else {
			lines.push(...renderTranscriptEntries(this.entries, width, {
				...this.renderOptions,
				cwd: this.cwd,
				expandToolOutput: this.expandToolOutput,
			}));
		}

		lines.push(horizontalRule(width));
		lines.push(renderFooter([["j/k", "scroll"], ["gg/G", "top/bot"], ["C-d/u", "page"], ["C-o", "tools"], ["h/esc", "back"], ["?", "help"], ["q", "quit"]], { mode: "NORMAL" }));

		this.contentHeight = lines.length;
		const maxScroll = Math.max(0, lines.length - 1);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		return this.scrollOffset > 0 ? lines.slice(this.scrollOffset) : lines;
	}

	private renderEntry(_entry: TranscriptEntry, _width: number): string[] {
		return [];
	}

	private isAtBottom(): boolean {
		return this.contentHeight > 0 && this.scrollOffset >= Math.max(0, this.contentHeight - 1);
	}

	private pinToBottom(): void {
		this.scrollOffset = Number.MAX_SAFE_INTEGER;
	}

}
