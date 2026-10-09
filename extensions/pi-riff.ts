import {
	AssistantMessageComponent,
	FooterComponent,
	InteractiveMode,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type InputEvent,
	type InputEventResult,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	getImageDimensions,
	Image,
	type ImageDimensions,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	Spacer,
	Text,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

// Global pi-riff behavior: compact tools, focused footer data, session naming, and clipboard images.
const MAX_CALL_LENGTH = 120;
const MAX_ERROR_LENGTH = 180;
const MAX_SESSION_NAME_LENGTH = 120;
const MAX_FRIENDLY_SUMMARY_LENGTH = 96;
const LEGACY_CTX_TITLE_ENTRY = "custom-pi-ctx-title";
const AGENT_TIMING_ENTRY = "compact-agent-timing";
const WORKING_SPINNER_INTERVAL_MS = 80;
const ANSI_STYLE_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const SPINNER_GLYPHS = ["◐", "◓", "◑", "◒"] as const;
const TOOL_DISPLAY_MODES = ["full", "compact", "command", "friendly"] as const;
const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;
const FOOTER_TIMER_STATE = Symbol.for("pi.custom-pi.footer-timer");
// Reuse state created by the previous filename during an in-process /reload.
const LEGACY_FOOTER_TIMER_STATE = Symbol.for("pi.compact-tool-output.footer-timer");
const USER_MESSAGE_TIME_STATE = Symbol.for("pi.custom-pi.user-message-time");
const MINIMAL_TOOL_STATE = Symbol.for("pi.custom-pi.minimal-tool-state");
const ASSISTANT_PRESENTATION_STATE = Symbol.for("pi.custom-pi.assistant-presentation-state");
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const EMPTY_HTML_COMMENT = /<!--[\t\n\r ]*-->/g;
const CLIPBOARD_TEMP_DIR = resolve(tmpdir());
const CLIPBOARD_IMAGE_PATH = new RegExp(
	`(^|[^A-Za-z0-9_./~-])(${escapeRegExp(CLIPBOARD_TEMP_DIR + sep)}pi-clipboard-`
		+ "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
		+ "\\.(?:png|jpe?g|webp|gif))(?=$|[^A-Za-z0-9_.-])",
	"gi",
);

type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;

type GenericToolResult = {
	durationMs?: number;
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
};

type GenericToolExecutionInstance = {
	args: Record<string, unknown>;
	expanded: boolean;
	imageComponents: Component[];
	imageSpacers: Component[];
	result?: GenericToolResult;
	toolName: string;
	getTextOutput(): string;
	removeChild(component: Component): void;
};

type GenericFallbackPrototype = {
	compactAllToolDurationPatched?: boolean;
	compactAllToolOutputPatched?: boolean;
	createCallFallback(this: GenericToolExecutionInstance): Component;
	createResultFallback(this: GenericToolExecutionInstance): Component | undefined;
	formatToolExecution(this: GenericToolExecutionInstance): string;
	getCallRenderer(this: GenericToolExecutionInstance): CallRenderer | undefined;
	getResultRenderer(this: GenericToolExecutionInstance): ResultRenderer | undefined;
	markExecutionStarted(this: GenericToolExecutionInstance): void;
	updateDisplay(this: GenericToolExecutionInstance): void;
	updateResult(this: GenericToolExecutionInstance, result: GenericToolResult, isPartial?: boolean): void;
};

type GenericTiming = {
	startedAt?: number;
	endedAt?: number;
};

type ToolDisplayMode = typeof TOOL_DISPLAY_MODES[number];

type MinimalToolDisplayState = {
	animationTimer?: ReturnType<typeof setInterval>;
	// Retained for wrappers installed by pre-Friendly /reload versions.
	collapsedStyle: "minimal" | "compact";
	displayMode: ToolDisplayMode;
	groupGeneration: number;
	groupsAfterBody: Set<number>;
	renderMinimal?: (instance: MinimalToolExecutionInstance, width: number) => string[];
	runningTools: Set<MinimalToolExecutionInstance>;
	spacedGroups: Set<number>;
};

type MinimalToolExecutionInstance = GenericToolExecutionInstance & {
	outputPad?: number;
	args: Record<string, unknown>;
	callRendererComponent?: Component;
	customPiToolGroup?: number;
	cwd: string;
	formatToolExecution(): string;
	isPartial: boolean;
	resultRendererComponent?: Component;
	ui: { requestRender(): void };
	setExpanded(expanded: boolean): void;
};

type MinimalToolPrototype = {
	customPiMinimalToolPatched?: boolean;
	customPiMinimalToolV2Patched?: boolean;
	customPiMinimalMousePatched?: boolean;
	handleMouse(this: MinimalToolExecutionInstance, event: TuiMouseEvent): TuiMouseEventResult | undefined;
	render(this: MinimalToolExecutionInstance, width: number): string[];
};

type ContainerPrototype = {
	addChild(component: Component): void;
	customPiTimingEntrySpacingPatched?: boolean;
	render(width: number): string[];
};

type ThinkingTiming = {
	durationMs?: number;
	startedAt?: number;
};

type AssistantPresentationState = {
	animationTimer?: ReturnType<typeof setInterval>;
	applyContentSpacing?: (
		instance: AssistantMessageInstance,
		message: AssistantMessage,
		timingMessage?: AssistantMessage,
	) => void;
	latestBodyStart?: { isAnimating(): boolean };
	requestRender?: () => void;
	streamingMessageKey?: number | string | true;
	styleAssistantLines?: (lines: string[]) => string[];
	thinkingTimings?: WeakMap<object, ThinkingTiming>;
	thinkingTimingsByTimestamp?: Map<number | string, ThinkingTiming>;
	transformAssistantMessage?: (message: AssistantMessage) => AssistantMessage;
	transformMarkdownLines?: (lines: string[], theme: FooterTheme | undefined) => string[];
};

type AssistantMessageInstance = {
	contentContainer: {
		children: Component[];
	};
	hideThinkingBlock: boolean;
	hiddenThinkingLabel?: string;
	outputPad?: number;
	thinkingVisibilityOverrides?: Map<number, boolean>;
};

type AssistantBodyPresentationInstance = Component & {
	content?: Component;
	customPiAssistantBodyDivider?: boolean;
	customPiAssistantBodyFrame?: boolean;
	customPiAssistantBodyRail?: boolean;
	customPiAssistantBodyStart?: boolean;
};

type AssistantMessagePrototype = {
	customPiContentSpacingV2Patched?: boolean;
	customPiThinkingSpacingPatched?: boolean;
	updateContent(this: AssistantMessageInstance, message: AssistantMessage): void;
};

type AgentTimingEntry = {
	round?: number;
	durationMs: number;
	completedAt?: number;
	totalDurationMs?: number;
};

type AgentTimingSessionEntry = {
	customType?: string;
	data?: unknown;
	timestamp: number | string;
	type: string;
};

function cumulativeAgentDurations(entries: Iterable<AgentTimingSessionEntry>): {
	byTimestamp: Map<number | string, number>;
	roundByTimestamp: Map<number | string, number>;
	completedRounds: number;
	totalDurationMs: number;
} {
	const byTimestamp = new Map<number | string, number>();
	const roundByTimestamp = new Map<number | string, number>();
	let completedRounds = 0;
	let totalDurationMs = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== AGENT_TIMING_ENTRY) continue;
		const timing = entry.data as AgentTimingEntry | undefined;
		if (typeof timing?.durationMs !== "number" || !Number.isFinite(timing.durationMs)) continue;
		totalDurationMs += Math.max(0, timing.durationMs);
		completedRounds += 1;
		byTimestamp.set(entry.timestamp, totalDurationMs);
		roundByTimestamp.set(entry.timestamp, completedRounds);
	}
	return { byTimestamp, roundByTimestamp, completedRounds, totalDurationMs };
}

type LegacyCtxTitleEntry = {
	title: string | null;
};

type UserMessageTimeState = {
	applyCompactLayout?: (instance: UserMessageInstance) => void;
	bindImages?: (instance: UserMessageInstance, message: AssistantMessage) => void;
	formatTimestamp?: (value: number | string | undefined) => string | undefined;
	getTheme?: () => FooterTheme;
	historicalImages: Map<number, AssistantMessage>;
	imagesExpanded: boolean;
	layoutRevision: number;
	pendingTimestamps: Array<number | string | undefined>;
	renderRightBubble?: (instance: UserMessageInstance, width: number) => string[] | undefined;
	setImageExpansion?: (instance: UserMessageInstance, expanded: boolean) => void;
};

type UserMessageContentBox = Component & {
	addChild(component: Component): void;
	children?: Component[];
	paddingX: number;
	paddingY: number;
	removeChild(component: Component): void;
};

type UserMessageImage = {
	dimensions: ImageDimensions;
	expanded: Image;
	thumbnail: Image;
};

type UserMessageInstance = {
	children: UserMessageContentBox[];
	outputPad?: number;
	customPiCompactLayout?: boolean;
	customPiImageExpanded?: boolean;
	customPiImageRevision?: number;
	customPiImages?: UserMessageImage[];
	customPiLayoutRevision?: number;
	customPiTimestamp?: number | string;
	rebuild(): void;
	text: string;
};

type UserMessagePrototype = {
	customPiCompactLayoutPatched?: boolean;
	customPiCompactLayoutV3Patched?: boolean;
	customPiImageExpansionPatched?: boolean;
	customPiImageExpansionV2Patched?: boolean;
	customPiRightBubblePatched?: boolean;
	customPiTimestampPatched?: boolean;
	customPiImageInvalidationPatched?: boolean;
	invalidate(this: UserMessageInstance): void;
	rebuild(this: UserMessageInstance): void;
	render(this: UserMessageInstance, width: number): string[];
	setExpanded?(this: UserMessageInstance, expanded: boolean): void;
};

type InteractiveModeInstance = {
	customPiAppliedToolDisplayMode?: ToolDisplayMode;
	loadedResourcesContainer?: { children: Component[] };
	chatContainer: {
		children: Component[];
	};
	setToolsExpanded(expanded: boolean): void;
	showStatus(message: string): void;
	toolOutputExpanded: boolean;
};

type InteractiveModePrototype = {
	customPiMarkdownThemePatched?: boolean;
	customPiToolModeCyclingPatched?: boolean;
	customPiToolModeRefreshPatched?: boolean;
	customPiUserImagesPatched?: boolean;
	customPiUserImagesV2Patched?: boolean;
	customPiUserMessagesV3Patched?: boolean;
	customPiUserMessageTimestampPatched?: boolean;
	getMarkdownThemeWithSettings(): Record<string, unknown>;
	toggleToolOutputExpansion(this: InteractiveModeInstance): void;
	setToolsExpanded(this: InteractiveModeInstance, expanded: boolean): void;
	addMessageToChat(
		this: InteractiveModeInstance,
		message: { content?: AssistantMessage["content"]; role?: string; timestamp?: number | string },
		options?: unknown,
	): void;
};

type FooterTheme = ExtensionContext["ui"]["theme"];

type FooterTimerState = {
	getTheme?: () => FooterTheme;
	renderIdentity?: (instance: FooterInstance, width: number, theme: FooterTheme) => string;
	renderStats?: (instance: FooterInstance, width: number, theme: FooterTheme) => string;
	suffix?: string;
};

type FooterSession = {
	state: {
		model?: {
			contextWindow?: number;
			id: string;
			provider: string;
			reasoning?: boolean;
		};
		thinkingLevel?: string;
	};
	sessionManager: {
		getCwd(): string;
		getEntries(): Array<{
			message?: {
				role: string;
				usage?: {
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
					input?: number;
					output?: number;
				};
			};
			type: string;
		}>;
		getSessionFile(): string | undefined;
		getSessionId(): string;
		getSessionName(): string | undefined;
	};
	routedModel?: { model: NonNullable<FooterSession["state"]["model"]>; thinkingLevel?: string };
	modelRuntime?: {
		isUsingSubscription(providerId: string): boolean;
	};
	getContextUsage(): {
		contextWindow: number;
		percent: number | null;
		tokens: number | null;
	} | undefined;
};

type FooterInstance = {
	footerData: {
		getGitBranch(): string | undefined;
		getExtensionStatuses(): ReadonlyMap<string, string>;
	};
	session: FooterSession;
	getSessionStats(): {
		usageTotals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
		latestCacheHitRate?: number;
		contextUsage: ReturnType<FooterSession["getContextUsage"]>;
	};
};

type FooterPrototype = {
	compactDynamicStatsPatched?: boolean;
	compactSessionIdentityPatched?: boolean;
	compactCtxTitleStatusLinePatched?: boolean;
	render(this: FooterInstance, width: number): string[];
};

type AssistantMessage = {
	role: string;
	timestamp?: number | string;
	content: Array<{
		data?: string;
		mimeType?: string;
		text?: string;
		type: string;
		thinking?: string;
		[key: string]: unknown;
	}>;
	[key: string]: unknown;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clipboardImageMimeType(bytes: Buffer): string | undefined {
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) {
		return "image/gif";
	}
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
		return "image/webp";
	}
	return undefined;
}

function readBoundedClipboardImage(path: string): Buffer | undefined {
	// Nonblocking/no-follow where supported prevents a clipboard-shaped path
	// from blocking on a FIFO or following an unrelated symlink.
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CLIPBOARD_IMAGE_BYTES) return undefined;
		// One sentinel byte detects growth after fstat. Allocation and every
		// read remain bounded even if the file changes while being read.
		const bytes = Buffer.alloc(stat.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length === 0 || length === bytes.length) return undefined;
		return bytes.subarray(0, length);
	} finally {
		closeSync(fd);
	}
}

function attachClipboardImages(event: InputEvent): InputEventResult | undefined {
	if (event.source !== "interactive") return undefined;

	const paths = [...event.text.matchAll(CLIPBOARD_IMAGE_PATH)].map((match) => match[2]);
	if (paths.length === 0) return undefined;

	const attachedPaths = new Set<string>();
	const clipboardImages: NonNullable<InputEvent["images"]> = [];
	for (const imagePath of new Set(paths)) {
		try {
			const bytes = readBoundedClipboardImage(imagePath);
			if (!bytes) continue;
			const mimeType = clipboardImageMimeType(bytes);
			if (!mimeType) continue;

			attachedPaths.add(imagePath);
			clipboardImages.push({ type: "image", data: bytes.toString("base64"), mimeType });
		} catch {
			// Leave unreadable paths unchanged so the model can still inspect the failure.
		}
	}
	if (clipboardImages.length === 0) return undefined;

	const text = event.text.replace(CLIPBOARD_IMAGE_PATH, (match, leading: string, imagePath: string) => {
		if (!attachedPaths.has(imagePath)) return match;
		return `${leading}[Image attached: ${basename(imagePath)}]`;
	});
	return {
		action: "transform",
		text,
		images: [...(event.images ?? []), ...clipboardImages],
	};
}

function cleanThinkingBlocks(message: AssistantMessage): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;

	let changed = false;
	for (const block of message.content) {
		if (block.type !== "thinking" || typeof block.thinking !== "string") continue;

		const cleaned = block.thinking.replace(EMPTY_HTML_COMMENT, "").trimEnd();
		if (cleaned === block.thinking) continue;

		block.thinking = cleaned;
		changed = true;
	}
	return changed;
}

function genericErrorText(instance: GenericToolExecutionInstance): string | undefined {
	const firstLine = instance.getTextOutput()
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	return firstLine ? compactText(firstLine, MAX_ERROR_LENGTH) : undefined;
}

function genericErrorComponent(instance: GenericToolExecutionInstance): Component | undefined {
	const error = genericErrorText(instance);
	return error ? new Text(error, 0, 0) : undefined;
}

function installGenericFallbackCompaction(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as GenericFallbackPrototype;
	if (prototype.compactAllToolOutputPatched) return;

	const renderFallback = prototype.createResultFallback;
	prototype.createResultFallback = function () {
		if (this.expanded || minimalToolDisplayState().displayMode === "compact") return renderFallback.call(this);
		return this.result?.isError ? genericErrorComponent(this) : undefined;
	};

	const getResultRenderer = prototype.getResultRenderer;
	const retainedResultComponents = new WeakMap<GenericToolExecutionInstance, Component>();
	prototype.getResultRenderer = function () {
		const renderer = getResultRenderer.call(this);
		if (!renderer) return undefined;

		return ((result, options, theme, context) => {
			const retainedComponent = retainedResultComponents.get(this);
			const retainedContext = retainedComponent
				? { ...context, lastComponent: retainedComponent }
				: context;
			const component = renderer(result, options, theme, retainedContext);
			retainedResultComponents.set(this, component);

			if (options.expanded || minimalToolDisplayState().displayMode === "compact") return component;
			if (this.result?.isError) return genericErrorComponent(this) ?? new Container();
			return new Container();
		}) as ResultRenderer;
	};

	const formatExpandedExecution = prototype.formatToolExecution;
	prototype.formatToolExecution = function () {
		if (this.expanded || minimalToolDisplayState().displayMode === "compact") return formatExpandedExecution.call(this);
		const error = this.result?.isError ? genericErrorText(this) : undefined;
		return error ? `${this.toolName}\n${error}` : this.toolName;
	};

	const updateDisplay = prototype.updateDisplay;
	prototype.updateDisplay = function () {
		updateDisplay.call(this);
		if (this.expanded || minimalToolDisplayState().displayMode === "compact") return;

		for (const image of this.imageComponents.splice(0)) this.removeChild(image);
		for (const spacer of this.imageSpacers.splice(0)) this.removeChild(spacer);
	};

	Object.defineProperty(prototype, "compactAllToolOutputPatched", {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});
}

function assistantPresentationState(): AssistantPresentationState {
	const globals = globalThis as typeof globalThis & {
		[ASSISTANT_PRESENTATION_STATE]?: AssistantPresentationState;
	};
	return globals[ASSISTANT_PRESENTATION_STATE] ??= {};
}

function compactThinkingForDisplay(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type !== "thinking" || typeof block.thinking !== "string") {
			content.push(block);
			continue;
		}

		const thinking = block.thinking.replace(/\n[\t ]*\n+/g, "\n").trim();
		const previous = content.at(-1);
		if (previous?.type === "thinking" && typeof previous.thinking === "string") {
			previous.thinking = `${previous.thinking}\n${thinking}`;
			changed = true;
		} else {
			content.push({ ...block, thinking });
			changed ||= thinking !== block.thinking;
		}
	}
	return changed ? { ...message, content } : message;
}

type AssistantContentRun = {
	kind: "body" | "thinking";
	thinking?: string;
};

function assistantContentRuns(message: AssistantMessage): AssistantContentRun[] {
	const runs: AssistantContentRun[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text?.trim()) {
			runs.push({ kind: "body" });
		} else if (block.type === "thinking" && block.thinking?.trim()) {
			const previous = runs.at(-1);
			if (previous?.kind === "thinking") previous.thinking = `${previous.thinking ?? ""}\n${block.thinking.trim()}`;
			else runs.push({ kind: "thinking", thinking: block.thinking.trim() });
		}
	}
	return runs;
}

function assistantMessageKey(message: AssistantMessage): number | string | true {
	return message.timestamp ?? true;
}

function isAssistantMessageStreaming(message: AssistantMessage): boolean {
	return assistantPresentationState().streamingMessageKey === assistantMessageKey(message);
}

function thinkingTiming(message: AssistantMessage, completed: boolean): ThinkingTiming {
	const state = assistantPresentationState();
	state.thinkingTimings ??= new WeakMap<object, ThinkingTiming>();
	state.thinkingTimingsByTimestamp ??= new Map<number | string, ThinkingTiming>();
	const timestamp = message.timestamp;
	let timing = timestamp === undefined
		? state.thinkingTimings.get(message as object)
		: state.thinkingTimingsByTimestamp.get(timestamp);
	if (!timing) {
		timing = completed ? {} : { startedAt: performance.now() };
		if (timestamp === undefined) state.thinkingTimings.set(message as object, timing);
		else {
			state.thinkingTimingsByTimestamp.set(timestamp, timing);
			if (state.thinkingTimingsByTimestamp.size > 1000) {
				const oldest = state.thinkingTimingsByTimestamp.keys().next().value;
				if (oldest !== undefined) state.thinkingTimingsByTimestamp.delete(oldest);
			}
		}
	} else if (completed && timing.durationMs === undefined && timing.startedAt !== undefined) {
		timing.durationMs = Math.max(0, performance.now() - timing.startedAt);
	}
	return timing;
}

function stopAssistantDividerAnimation(): void {
	const state = assistantPresentationState();
	if (state.animationTimer !== undefined) clearInterval(state.animationTimer);
	state.animationTimer = undefined;
}

function riffHighlight(text: string, role: "success" | "accent" | "warning", bold = false,
	theme = footerTimerState().getTheme?.()): string {
	const styledText = bold ? theme?.bold?.(text) ?? text : text;
	return theme?.fg(role, styledText) ?? styledText;
}

function syncAssistantDividerAnimation(): void {
	const state = assistantPresentationState();
	if (!state.requestRender || !state.latestBodyStart?.isAnimating()) {
		stopAssistantDividerAnimation();
		return;
	}
	if (state.animationTimer !== undefined) return;
	state.animationTimer = setInterval(() => {
		const current = assistantPresentationState();
		if (!current.requestRender || !current.latestBodyStart?.isAnimating()) {
			stopAssistantDividerAnimation();
			return;
		}
		current.requestRender();
	}, WORKING_SPINNER_INTERVAL_MS);
}

class AssistantBodyStartComponent implements Component {
	readonly customPiAssistantBodyStart = true;

	constructor(
		readonly content: Component,
		private completed: boolean,
	) {
		assistantPresentationState().latestBodyStart = this;
		syncAssistantDividerAnimation();
	}

	isAnimating(): boolean {
		return !this.completed;
	}

	setCompleted(completed: boolean): void {
		this.completed = completed;
		syncAssistantDividerAnimation();
	}

	render(width: number): string[] {
		const latest = assistantPresentationState().latestBodyStart === this;
		if (!latest) return this.content.render(width);
		const dividerWidth = Math.max(0, width);
		let marker = "";
		if (dividerWidth > 0) {
			const proportionalWidth = Math.max(1, Math.round(dividerWidth * 0.8));
			const markerWidth = proportionalWidth % 2 === 0
				? proportionalWidth + (proportionalWidth < dividerWidth ? 1 : -1)
				: proportionalWidth;
			const leftPadding = Math.floor((dividerWidth - markerWidth) / 2);
			const rightPadding = dividerWidth - markerWidth - leftPadding;
			if (this.completed) {
				marker = " ".repeat(leftPadding)
					+ riffHighlight("━".repeat(markerWidth), "accent")
					+ " ".repeat(rightPadding);
			} else {
				const frameIndex = Math.floor(performance.now() / WORKING_SPINNER_INTERVAL_MS)
					% SPINNER_GLYPHS.length;
				const sideWidth = Math.floor(markerWidth / 2);
				marker = " ".repeat(leftPadding)
					+ riffHighlight("━".repeat(sideWidth), "accent")
					+ riffHighlight(SPINNER_GLYPHS[frameIndex], "accent", true)
					+ riffHighlight("━".repeat(sideWidth), "accent")
					+ " ".repeat(rightPadding);
			}
		}
		return [marker, ...this.content.render(width)];
	}

	invalidate(): void {
		this.content.invalidate?.();
	}
}

class CollapsibleThinkingComponent implements Component {
	private readonly steps: number;
	constructor(
		private readonly content: Component,
		thinking: string,
		private readonly completed: boolean,
		private readonly expanded: boolean,
		private readonly durationMs?: number,
		private readonly hiddenLabel = "Thinking...",
		private readonly paddingX = 1,
	) {
		// A live hidden label and an expanded block do not need a step count.
		this.steps = completed && !expanded ? thinking.split("\n").filter((line) => line.trim()).length : 0;
	}

	render(width: number): string[] {
		if (this.expanded) return this.content.render(width);
		if (width <= 0) return [];
		const theme = footerTimerState().getTheme?.();
		const padding = Math.min(Math.max(0, this.paddingX), Math.floor((width - 1) / 2));
		const duration = this.durationMs === undefined ? "" : ` · ${formatDuration(this.durationMs)}`;
		const label = this.completed
			? `Thinking · ${this.steps} ${this.steps === 1 ? "step" : "steps"}${duration}`
			: this.hiddenLabel;
		const styled = theme?.italic(theme.fg("thinkingText", label)) ?? label;
		const margin = " ".repeat(padding);
		return [margin + truncateToWidth(styled, width - padding * 2, "...", true) + margin];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.content.handleMouse?.(event);
	}

	invalidate(): void {
		this.content.invalidate?.();
	}
}

function applyAssistantContentSpacing(
	instance: AssistantMessageInstance,
	message: AssistantMessage,
	timingMessage: AssistantMessage = message,
): void {
	const runs = assistantContentRuns(message);
	const children = instance.contentContainer.children;
	if (runs[0]?.kind === "thinking" && children[0] instanceof Spacer) children.shift();

	const completed = !isAssistantMessageStreaming(timingMessage)
		&& typeof timingMessage.stopReason === "string"
		&& Boolean(timingMessage.stopReason);
	const timing = thinkingTiming(timingMessage, completed);
	let childIndex = 0;
	let thinkingRunIndex = 0;
	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const run = runs[runIndex];
		const spacerStart = childIndex;
		while (children[childIndex] instanceof Spacer) childIndex += 1;
		if (run.kind === "body") {
			children.splice(spacerStart, childIndex - spacerStart, new Spacer(1));
			childIndex = spacerStart + 1;
		}
		if (!children[childIndex]) break;
		if (run.kind === "thinking" && !(children[childIndex] instanceof CollapsibleThinkingComponent)) {
			children[childIndex] = new CollapsibleThinkingComponent(
				children[childIndex],
				run.thinking ?? "",
				completed,
				!(instance.thinkingVisibilityOverrides?.get(thinkingRunIndex) ?? instance.hideThinkingBlock),
				timing.durationMs,
				instance.hiddenThinkingLabel,
				instance.outputPad,
			);
		} else if (run.kind === "body") {
			const body = children[childIndex] as AssistantBodyPresentationInstance;
			if (body.customPiAssistantBodyStart) {
				assistantPresentationState().latestBodyStart = body as AssistantBodyStartComponent;
				(body as AssistantBodyStartComponent).setCompleted(completed);
			} else {
				const wrapped = body.customPiAssistantBodyDivider
					|| body.customPiAssistantBodyFrame
					|| body.customPiAssistantBodyRail;
				const content = wrapped && body.content ? body.content : body;
				children[childIndex] = new AssistantBodyStartComponent(content, completed);
			}
		}
		if (run.kind === "thinking") thinkingRunIndex += 1;
		childIndex += 1;
		if (run.kind === "body" && runs[runIndex + 1]?.kind === "thinking"
			&& !(children[childIndex] instanceof Spacer)) {
			children.splice(childIndex, 0, new Spacer(1));
		}
	}
	const endsWithBody = runs.at(-1)?.kind === "body";
	const hasToolCalls = message.content.some((block) => block.type === "toolCall");
	if (endsWithBody && hasToolCalls && !(children.at(-1) instanceof Spacer)) children.push(new Spacer(1));
}

function installAssistantPresentation(): void {
	const state = assistantPresentationState();
	// Identity functions disable presentation patches retained by an earlier hot reload.
	state.applyContentSpacing = applyAssistantContentSpacing;
	state.styleAssistantLines = (lines) => lines;
	state.transformAssistantMessage = compactThinkingForDisplay;
	state.transformMarkdownLines = (lines) => lines;

	const assistantPrototype = AssistantMessageComponent.prototype as unknown as AssistantMessagePrototype;
	if (!assistantPrototype.customPiThinkingSpacingPatched) {
		const updateContent = assistantPrototype.updateContent;
		assistantPrototype.updateContent = function (message) {
			const transformed = assistantPresentationState().transformAssistantMessage?.(message) ?? message;
			updateContent.call(this, transformed);
		};
		Object.defineProperty(assistantPrototype, "customPiThinkingSpacingPatched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}
	if (!assistantPrototype.customPiContentSpacingV2Patched) {
		const updateSpacing = assistantPrototype.updateContent;
		assistantPrototype.updateContent = function (message) {
			updateSpacing.call(this, message);
			const transformed = assistantPresentationState().transformAssistantMessage?.(message) ?? message;
			assistantPresentationState().applyContentSpacing?.(this, transformed, message);
		};
		Object.defineProperty(assistantPrototype, "customPiContentSpacingV2Patched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}
}

function minimalToolDisplayState(): MinimalToolDisplayState {
	const globals = globalThis as typeof globalThis & {
		[MINIMAL_TOOL_STATE]?: MinimalToolDisplayState;
	};
	const state = globals[MINIMAL_TOOL_STATE] ??= {
		collapsedStyle: "minimal",
		displayMode: "friendly",
		groupGeneration: 0,
		groupsAfterBody: new Set<number>(),
		runningTools: new Set<MinimalToolExecutionInstance>(),
		spacedGroups: new Set<number>(),
	};
	state.displayMode ??= "friendly";
	state.collapsedStyle = state.displayMode === "compact" ? "compact" : "minimal";
	state.groupGeneration ??= 0;
	state.groupsAfterBody ??= new Set<number>();
	state.runningTools ??= new Set<MinimalToolExecutionInstance>();
	state.spacedGroups ??= new Set<number>();
	return state;
}

function setToolDisplayMode(mode: ToolDisplayMode): void {
	const state = minimalToolDisplayState();
	state.displayMode = mode;
	state.collapsedStyle = mode === "compact" ? "compact" : "minimal";
	if (mode === "compact" || mode === "full") stopMinimalToolAnimation();
}

function minimalPath(value: unknown, cwd: string): string {
	if (typeof value !== "string" || !value) return "";
	if (!isAbsolute(value)) return value;
	const relativeToCwd = relative(resolve(cwd), resolve(value));
	const isInsideCwd = relativeToCwd === ""
		|| (relativeToCwd !== ".." && !relativeToCwd.startsWith(`..${sep}`) && !isAbsolute(relativeToCwd));
	return isInsideCwd ? relativeToCwd || "." : formatFooterCwd(value);
}

function stripPassiveShellPrefixes(command: string): string {
	let stripped = command;
	while (true) {
		const match = stripped.match(/^sleep\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:;|&&)\s*/);
		if (!match) return stripped;
		stripped = stripped.slice(match[0].length);
	}
}

function compactCommandPaths(value: unknown, cwd: string): string {
	if (typeof value !== "string") return "";
	let command = stripPassiveShellPrefixes(value.replace(/\s+/g, " ").trim());
	const resolvedCwd = resolve(cwd);
	command = command.replaceAll(`${resolvedCwd}${sep}`, "");
	command = command.replace(new RegExp(`${escapeRegExp(resolvedCwd)}(?=$|[\\s'\"\x60])`, "g"), ".");
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home) {
		const resolvedHome = resolve(home);
		command = command.replaceAll(`${resolvedHome}${sep}`, `~${sep}`);
		command = command.replace(new RegExp(`${escapeRegExp(resolvedHome)}(?=$|[\\s'\"\x60])`, "g"), "~");
	}
	return command;
}

function minimalArgumentPreview(args: Record<string, unknown>): string {
	const preferredKeys = ["path", "file_path", "query", "url", "pattern", "status"];
	for (const key of preferredKeys) {
		const value = args[key];
		if (typeof value === "string" && value) return value;
	}
	for (const key of ["queries", "urls", "tool_uses"]) {
		const value = args[key];
		if (!Array.isArray(value) || value.length === 0) continue;
		const first = typeof value[0] === "string" ? value[0] : "";
		return first ? `${first}${value.length > 1 ? ` (+${value.length - 1})` : ""}` : `${value.length} items`;
	}
	return "";
}

type MinimalToolSummary = {
	detail: string;
	emphasizedDetailRange?: [number, number];
	emphasizedDetailRanges?: Array<[number, number]>;
	label: string;
};

function shellCommandTokenRanges(command: string): Array<Array<[number, number]>> {
	const segments: Array<Array<[number, number]>> = [];
	let segment: Array<[number, number]> = [];
	let index = 0;
	while (index < command.length) {
		while (/\s/.test(command[index] ?? "")) index += 1;
		if (index >= command.length) break;
		if (command.startsWith("&&", index) || command.startsWith("||", index)) {
			if (segment.length > 0) segments.push(segment);
			segment = [];
			index += 2;
			continue;
		}
		if (/[;|]/.test(command[index] ?? "")) {
			if (segment.length > 0) segments.push(segment);
			segment = [];
			index += 1;
			continue;
		}
		const start = index;
		let quote: "'" | '"' | "`" | undefined;
		while (index < command.length) {
			const character = command[index];
			if (character === "\\" && quote !== "'") {
				index += Math.min(2, command.length - index);
				continue;
			}
			if (quote) {
				if (character === quote) quote = undefined;
				index += 1;
				continue;
			}
			if (character === "'" || character === '"' || character === "`") {
				quote = character;
				index += 1;
				continue;
			}
			if (/\s/.test(character ?? "") || /[;|]/.test(character ?? "")) break;
			index += 1;
		}
		if (index > start) segment.push([start, index]);
	}
	if (segment.length > 0) segments.push(segment);
	return segments;
}

type IndexedTokenRange = {
	index: number;
	range: [number, number];
};

function tokenText(command: string, range: [number, number]): string {
	return command.slice(range[0], range[1]);
}

function unquotedToken(value: string): string {
	const first = value[0];
	return value.length >= 2 && (first === "'" || first === '"') && value.at(-1) === first
		? value.slice(1, -1)
		: value;
}

function firstPositionalToken(
	command: string,
	tokens: Array<[number, number]>,
	valueOptions: ReadonlySet<string>,
	startAt = 0,
): IndexedTokenRange | undefined {
	for (let index = startAt; index < tokens.length; index += 1) {
		const token = tokenText(command, tokens[index]);
		if (token === "--") return index + 1 < tokens.length ? { index: index + 1, range: tokens[index + 1] } : undefined;
		if (valueOptions.has(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		return { index, range: tokens[index] };
	}
	return undefined;
}

function rangeAfterOption(command: string, tokens: Array<[number, number]>, options: ReadonlySet<string>): [number, number] | undefined {
	for (let index = 0; index < tokens.length; index += 1) {
		if (options.has(tokenText(command, tokens[index]))) return tokens[index + 1];
	}
	return undefined;
}

function lastPositionalRange(command: string, tokens: Array<[number, number]>, valueOptions: ReadonlySet<string>): [number, number] | undefined {
	let last: [number, number] | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokenText(command, tokens[index]);
		if (valueOptions.has(token)) {
			index += 1;
			continue;
		}
		if (!token.startsWith("-")) last = tokens[index];
	}
	return last;
}

function withSemanticRange(executableRange: [number, number], semanticRange?: [number, number]): Array<[number, number]> {
	return semanticRange ? [executableRange, semanticRange] : [executableRange];
}

function bashSemanticRanges(command: string): Array<[number, number]> {
	return shellCommandTokenRanges(command).flatMap((tokens) => bashSemanticRangesForSegment(command, tokens));
}

function bashSemanticRangesForSegment(command: string, tokens: Array<[number, number]>): Array<[number, number]> {
	const executableIndex = tokens.findIndex(([start, end]) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokenText(command, [start, end])));
	if (executableIndex < 0) return [];
	const executableRange = tokens[executableIndex];
	const executable = basename(tokenText(command, executableRange));
	const args = tokens.slice(executableIndex + 1);

	if (executable === "git") {
		const semantic = firstPositionalToken(command, args, new Set(["-C", "-c", "--git-dir", "--work-tree", "--config-env"]));
		return withSemanticRange(executableRange, semantic?.range);
	}

	if (executable === "rg") {
		const patternAfterOption = rangeAfterOption(command, args, new Set(["-e", "--regexp"]));
		if (patternAfterOption) return withSemanticRange(executableRange, patternAfterOption);
		for (const range of args) {
			const token = tokenText(command, range);
			if (token.startsWith("--regexp=")) return withSemanticRange(executableRange, [range[0] + "--regexp=".length, range[1]]);
			if (token.startsWith("-e") && token.length > 2) return withSemanticRange(executableRange, [range[0] + 2, range[1]]);
		}
		const semantic = firstPositionalToken(command, args, new Set(["-g", "--glob", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C", "--context"]));
		return withSemanticRange(executableRange, semantic?.range);
	}

	if (executable === "npm") {
		const action = firstPositionalToken(command, args, new Set(["--prefix", "--cache", "--workspace", "-w"]));
		if (!action) return [executableRange];
		const actionText = unquotedToken(tokenText(command, action.range));
		const script = actionText === "run" ? firstPositionalToken(command, args, new Set(), action.index + 1) : undefined;
		return withSemanticRange(executableRange, script?.range ?? action.range);
	}

	if (executable === "node") {
		const preferredMode = args.find((range) => /^(?:--test(?:=.*)?|--check|-e|--eval|-p|--print)$/.test(tokenText(command, range)));
		if (preferredMode) return withSemanticRange(executableRange, preferredMode);
		const script = firstPositionalToken(command, args, new Set(["--input-type", "--require", "-r", "--loader", "--import", "--conditions"]));
		if (script && !/^(?:-|<|<<)/.test(tokenText(command, script.range))) return withSemanticRange(executableRange, script.range);
		const inputType = args.find((range) => tokenText(command, range).startsWith("--input-type"));
		return withSemanticRange(executableRange, inputType);
	}

	if (executable === "playwright-cli") {
		const action = firstPositionalToken(command, args, new Set(["-s", "--session", "--timeout"]));
		return withSemanticRange(executableRange, action?.range);
	}

	if (executable === "make") {
		const target = firstPositionalToken(command, args, new Set(["-C", "-f", "--file", "--directory"]));
		return withSemanticRange(executableRange, target?.range);
	}

	if (executable === "find") {
		const pattern = rangeAfterOption(command, args, new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"]));
		return withSemanticRange(executableRange, pattern);
	}

	if (executable === "jq") {
		const filterFile = rangeAfterOption(command, args, new Set(["-f", "--from-file"]));
		if (filterFile) return withSemanticRange(executableRange, filterFile);
		for (let index = 0; index < args.length; index += 1) {
			const token = tokenText(command, args[index]);
			if (token === "--arg" || token === "--argjson" || token === "--slurpfile" || token === "--rawfile" || token === "--argfile") {
				index += 2;
				continue;
			}
			if (token === "-L") {
				index += 1;
				continue;
			}
			if (token === "--") return index + 1 < args.length ? withSemanticRange(executableRange, args[index + 1]) : [executableRange];
			if (!token.startsWith("-")) return withSemanticRange(executableRange, args[index]);
		}
		return [executableRange];
	}

	if (executable === "curl") {
		const url = args.find((range) => /^https?:\/\//.test(unquotedToken(tokenText(command, range))));
		return withSemanticRange(executableRange, url);
	}

	if (/^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/.test(executable)) {
		const module = rangeAfterOption(command, args, new Set(["-m"]));
		if (module) return withSemanticRange(executableRange, module);
		const mode = args.find((range) => tokenText(command, range) === "-c");
		if (mode) return withSemanticRange(executableRange, mode);
		const script = firstPositionalToken(command, args, new Set(["-W", "-X"]));
		return withSemanticRange(executableRange, script?.range);
	}

	if (executable === "pi") {
		const priority = ["--list-models", "--version", "--help", "install", "remove", "update", "list", "config"];
		const action = priority
			.map((value) => args.find((range) => tokenText(command, range) === value))
			.find(Boolean)
			?? args.find((range) => tokenText(command, range) === "--mode");
		return withSemanticRange(executableRange, action);
	}

	if (executable === "tmux") {
		const action = firstPositionalToken(command, args, new Set(["-L", "-S", "-f"]));
		return withSemanticRange(executableRange, action?.range);
	}

	if (executable === "gh" || executable === "docker" || executable === "uv") {
		const action = firstPositionalToken(command, args, new Set(["--repo", "-R", "--host"]));
		return withSemanticRange(executableRange, action?.range);
	}

	if (executable === "shasum" || executable === "sha256sum") {
		return withSemanticRange(executableRange, lastPositionalRange(command, args, new Set(["-a"])));
	}

	if (executable === "cp" || executable === "mv" || executable === "rm" || executable === "mkdir") {
		return withSemanticRange(executableRange, lastPositionalRange(command, args, new Set()));
	}

	return [executableRange];
}

function firstShellCommandRange(command: string): [number, number] | undefined {
	let index = 0;
	while (index < command.length) {
		while (/\s/.test(command[index] ?? "")) index += 1;
		if (index >= command.length) return undefined;

		const start = index;
		let quote: "'" | '"' | "`" | undefined;
		while (index < command.length) {
			const character = command[index];
			if (character === "\\" && quote !== "'") {
				index += Math.min(2, command.length - index);
				continue;
			}
			if (quote) {
				if (character === quote) quote = undefined;
				index += 1;
				continue;
			}
			if (character === "'" || character === '"' || character === "`") {
				quote = character;
				index += 1;
				continue;
			}
			if (/\s/.test(character ?? "")) break;
			index += 1;
		}

		const token = command.slice(start, index);
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return [start, index];
	}
	return undefined;
}

function emphasizedPathRange(detail: string, path: string): [number, number] | undefined {
	if (!path) return undefined;
	const pathStart = detail.indexOf(path);
	if (pathStart < 0) return undefined;
	const fileNameStart = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	return [pathStart + fileNameStart, pathStart + path.length];
}

function minimalToolSummary(instance: MinimalToolExecutionInstance): MinimalToolSummary {
	const args = instance.args ?? {};
	const path = minimalPath(args.path ?? args.file_path, instance.cwd);
	switch (instance.toolName) {
		case "bash": {
			const detail = compactCommandPaths(args.command, instance.cwd);
			return { label: "$", detail, emphasizedDetailRanges: bashSemanticRanges(detail) };
		}
		case "read": {
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const range = offset !== undefined || limit !== undefined
				? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
				: "";
			const detail = `${path}${range}`;
			return { label: "read", detail, emphasizedDetailRange: emphasizedPathRange(detail, path) };
		}
		case "edit":
			return { label: "edit", detail: path, emphasizedDetailRange: emphasizedPathRange(path, path) };
		case "write":
			return { label: "write", detail: path, emphasizedDetailRange: emphasizedPathRange(path, path) };
		case "grep": {
			const detail = `/${compactText(args.pattern, 60)}/ in ${path || "."}`;
			return { label: "grep", detail, emphasizedDetailRange: emphasizedPathRange(detail, path || ".") };
		}
		case "find": {
			const detail = `${compactText(args.pattern, 60)} in ${path || "."}`;
			return { label: "find", detail, emphasizedDetailRange: emphasizedPathRange(detail, path || ".") };
		}
		case "ls": {
			const detail = path || ".";
			return { label: "ls", detail, emphasizedDetailRange: emphasizedPathRange(detail, detail) };
		}
		default:
			return { label: instance.toolName, detail: compactText(minimalArgumentPreview(args), MAX_CALL_LENGTH) };
	}
}

function completedResultLineCount(instance: MinimalToolExecutionInstance): number | undefined {
	if (instance.isPartial || instance.result?.isError || !instance.result) return undefined;
	if (instance.result.content.some((block) => block.type === "image")) return undefined;
	const text = instance.result.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n")
		.replace(/\n\n\[[^\n]*\]\s*$/, "")
		.replace(/\n$/, "");
	return text ? text.split("\n").length : 0;
}

function pluralizedFact(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function minimalToolFact(instance: MinimalToolExecutionInstance): string {
	if (instance.result?.isError) return "";
	const args = instance.args ?? {};
	switch (instance.toolName) {
		case "read": {
			const lines = completedResultLineCount(instance);
			return lines === undefined ? "" : pluralizedFact(lines, "line");
		}
		case "edit": {
			const edits = Array.isArray(args.edits) ? args.edits.length : 0;
			return edits ? pluralizedFact(edits, "edit") : "";
		}
		case "write": {
			const bytes = typeof args.content === "string" ? Buffer.byteLength(args.content, "utf8") : 0;
			return pluralizedFact(bytes, "byte");
		}
		case "grep": {
			const lines = completedResultLineCount(instance);
			if (lines === undefined) return "";
			const hasContext = typeof args.context === "number" && args.context > 0;
			return pluralizedFact(lines, hasContext ? "line" : "match", hasContext ? "lines" : "matches");
		}
		case "find": {
			const files = completedResultLineCount(instance);
			return files === undefined ? "" : pluralizedFact(files, "file");
		}
		case "ls": {
			const entries = completedResultLineCount(instance);
			return entries === undefined ? "" : pluralizedFact(entries, "entry", "entries");
		}
		default:
			return "";
	}
}

function friendlyToolFact(instance: MinimalToolExecutionInstance): string {
	if (instance.result?.isError) return "";
	const toolName = instance.toolName.split(".").at(-1) ?? instance.toolName;
	if (toolName === "read") {
		const lines = completedResultLineCount(instance);
		return lines === undefined ? "" : `${lines} 行`;
	}
	if (toolName === "write") {
		const content = instance.args?.content;
		const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
		return bytes < 1024 ? `${bytes} 字节` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	}
	return "";
}

function truncateMiddleToWidth(text: string, maxWidth: number, ellipsis: string): string {
	const width = visibleWidth(text);
	if (width <= maxWidth) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (maxWidth <= ellipsisWidth) return truncateToWidth(ellipsis, maxWidth, "", false);
	const remainingWidth = maxWidth - ellipsisWidth;
	const prefixWidth = Math.ceil(remainingWidth / 2);
	const suffixWidth = remainingWidth - prefixWidth;
	const prefix = sliceByColumn(text, 0, prefixWidth, true);
	const suffix = sliceByColumn(text, width - suffixWidth, suffixWidth, true);
	return `${prefix}${ANSI_STYLE_RESET}${ellipsis}${suffix}`;
}

function friendlyPath(value: unknown, cwd: string, fallback = "文件"): string {
	const rawPath = minimalPath(value, cwd);
	const path = rawPath.replace(/^\.\//, "");
	if (!path) return fallback;
	if (visibleWidth(path) <= 52) return path;
	const parts = path.split(/[/\\]/).filter(Boolean);
	const tail = parts.slice(-2).join("/");
	if (visibleWidth(tail) <= 52) return tail;
	const fileName = parts.at(-1) ?? path;
	return visibleWidth(fileName) <= 50 ? `…/${fileName}` : compactText(fileName, 50);
}

function friendlyPathTail(path: string, count = 2): string {
	const parts = path.split(/[/\\]/).filter(Boolean);
	return parts.slice(-count).join("/") || path;
}

function friendlyFileVerb(path: string, operation: "edit" | "read" | "write"): string {
	const fileName = basename(path).toLowerCase();
	if (operation === "read") {
		if (fileName === "skill.md") return "读取技能说明";
		if (fileName === "agents.md") return "读取项目规则";
		if (fileName === "context.md" || fileName === "context-map.md") return "读取项目上下文";
		if (fileName === "workflow.md") return "读取工作流说明";
		if (/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/.test(fileName)) return "查看图片";
		if (/\.(?:log|out)$/.test(fileName)) return "查看日志";
		if (/\.jsonl$/.test(fileName)) return "读取会话记录";
		return "读取";
	}
	const isTest = /(?:^|[._-])tests?(?:[._-]|$)/.test(fileName) || /(?:^|[/\\])tests?(?:[/\\]|$)/i.test(path);
	if (isTest) return "更新测试";
	if (/\.(?:md|mdx|rst)$/.test(fileName)) return operation === "write" ? "生成文档" : "更新文档";
	if (/\.(?:json|jsonc|toml|ya?ml|ini|env)$/.test(fileName)) return "更新配置";
	return operation === "write" ? "写入" : "修改";
}

function friendlyUrlTarget(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "";
	const trimmed = value.trim();
	try {
		const url = new URL(trimmed);
		const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
		return `${url.host}${path}`;
	} catch {
		return basename(trimmed) || trimmed;
	}
}

function friendlyFirstString(value: unknown): { count: number; value: string } {
	if (typeof value === "string" && value.trim()) return { count: 1, value: value.trim() };
	if (!Array.isArray(value)) return { count: 0, value: "" };
	const strings = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
	return { count: strings.length, value: strings[0]?.trim() ?? "" };
}

type FriendlyShellSource = {
	command: string;
	inlineBody: string;
};

function prepareFriendlyShellSource(value: string): FriendlyShellSource {
	const lines = value.replace(/\\\r?\n/g, " ").replace(/\r\n?/g, "\n").split("\n");
	const commandLines: string[] = [];
	const bodyLines: string[] = [];
	let delimiter: string | undefined;
	for (const line of lines) {
		if (delimiter) {
			if (line.trim() === delimiter) delimiter = undefined;
			else bodyLines.push(line);
			continue;
		}
		const heredoc = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
		if (heredoc) delimiter = heredoc[2];
		const commandLine = heredoc ? line.replace(heredoc[0], "") : line;
		if (commandLine.trim()) commandLines.push(commandLine.trim());
	}
	return {
		command: stripPassiveShellPrefixes(commandLines.join(" ; ").replace(/[\t ]+/g, " ").trim()),
		inlineBody: bodyLines.join("\n"),
	};
}

function friendlyPythonScriptAction(scriptName: string, cwd: string): FriendlyShellAction {
	const path = friendlyPath(scriptName, cwd);
	return { key: `python-script:${path}`, label: `运行 Python 脚本：${path}` };
}

function friendlyInlineScriptAction(runtime: "node" | "python", _source: string): FriendlyShellAction {
	return runtime === "python"
		? { key: "python-inline", label: "执行内联 Python" }
		: { key: "node-inline", label: "执行内联 Node.js" };
}

// Classify tokenized shell segments so quoted command text cannot trigger unrelated actions.
type FriendlyShellAction = {
	key: string;
	label: string;
	supporting?: boolean;
};

function shellRangeText(command: string, range: [number, number] | undefined): string {
	return range ? unquotedToken(tokenText(command, range)) : "";
}

function friendlyShellPath(command: string, range: [number, number] | undefined, cwd: string): string {
	const value = shellRangeText(command, range);
	return value ? friendlyPath(value, cwd, value) : "";
}

function friendlyShellTarget(command: string, args: Array<[number, number]>, cwd: string): string {
	for (let index = args.length - 1; index >= 0; index -= 1) {
		const value = shellRangeText(command, args[index]);
		const previous = shellRangeText(command, args[index - 1]);
		if (!value || value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) continue;
		if (/^(?:\d*(?:>>?|<<?|>&|<&).*)$/.test(value) || /^(?:>>?|<<?|>&|<&)$/.test(previous)) continue;
		if (/^(?:then|else|fi|do|done|true|false|&)$/i.test(value)) continue;
		return friendlyPath(value, cwd, value);
	}
	return "";
}

function friendlyTargetSummary(values: string[], cwd: string, testOnly = false): string {
	const ignored = new Set(["discover", "node", "python", "python3", "pytest", "test", "tests", "unittest"]);
	const candidates = values
		.map((value) => unquotedToken(value).replace(/^["']|["']$/g, ""))
		.filter((value) => value && !value.startsWith("-") && !ignored.has(value.toLowerCase()));
	const fileTargets = candidates.filter((value) => /\.(?:bash|cjs|js|jsx|mjs|py|sh|ts|tsx|vue|zsh)(?::|$)/i.test(value));
	const testTargets = fileTargets.length > 0 ? fileTargets : candidates.filter((value) => (
		/(?:^|[/\\.:_-])tests?(?:[/\\.:_-]|$)/i.test(value)
		|| /(?:Test|Tests)\.[A-Za-z_]/.test(value)
	));
	const selected = testOnly ? testTargets : fileTargets;
	const unique = selected.filter((value, index) => selected.indexOf(value) === index);
	if (unique.length === 0) return "";
	const first = friendlyPath(unique[0], cwd, compactText(unique[0], 50));
	return unique.length === 1 ? first : `${first} 等 ${unique.length} 项`;
}

function friendlyTestAction(values: string[], cwd: string): FriendlyShellAction {
	const target = friendlyTargetSummary(values, cwd, true);
	return { key: "project-test", label: target ? `运行测试：${target}` : "运行项目测试" };
}

function friendlyRunnerAction(name: string, values: string[], cwd = ""): FriendlyShellAction | undefined {
	const executable = basename(name).toLowerCase();
	if (executable === "pytest" || executable === "unittest") return friendlyTestAction(values, cwd);
	if (executable === "ruff" || /^eslint(?:\.js)?$/.test(executable)) {
		const format = values.includes("format");
		return format ? { key: "project-format-check", label: values.includes("--check") ? "检查代码格式" : "格式化代码" } : { key: "project-lint", label: "检查代码规范" };
	}
	if (executable === "prettier") return values.includes("--write")
		? { key: "project-format", label: "格式化代码" }
		: { key: "project-format-check", label: "检查代码格式" };
	if (executable === "stylelint") return { key: "project-lint", label: "检查代码规范" };
	if (executable === "mypy" || executable === "pyright") return { key: "python-types", label: "检查 Python 类型" };
	if (executable === "tsc" || executable === "vue-tsc") return { key: "project-types", label: "检查项目类型" };
	return undefined;
}

function friendlyScriptAction(scriptValue: string): FriendlyShellAction {
	const script = unquotedToken(scriptValue);
	const normalized = script.toLowerCase();
	return { key: `project-script:${normalized}`, label: `运行项目脚本：${compactText(script, 36)}` };
}

function friendlyGitAction(command: string, args: Array<[number, number]>, cwd: string): FriendlyShellAction {
	const action = firstPositionalToken(command, args, new Set(["-C", "-c", "--git-dir", "--work-tree", "--config-env"]));
	if (!action) return { key: "git-info", label: "查询仓库信息" };
	const operation = shellRangeText(command, action.range).toLowerCase();
	const rest = args.slice(action.index + 1);
	const values = rest.map((range) => shellRangeText(command, range));
	const targetRange = firstPositionalToken(command, rest, new Set(["-m", "--message", "-F", "--file", "--author", "--date"]))?.range;
	const target = friendlyShellPath(command, targetRange, cwd);

	switch (operation) {
		case "status":
			return { key: "git-status", label: "检查仓库状态" };
		case "diff":
			if (values.includes("--check")) return { key: "git-diff-check", label: "检查差异格式" };
			if (values.includes("--cached") || values.includes("--staged")) return { key: "git-diff-staged", label: "查看暂存差异" };
			if (values.includes("--stat") || values.includes("--name-only") || values.includes("--name-status")) {
				return { key: "git-diff-summary", label: "查看变更摘要" };
			}
			return { key: "git-diff", label: "查看代码差异" };
		case "log":
			return { key: "git-log", label: "查看提交记录" };
		case "show":
			return { key: "git-show", label: target ? `查看提交 ${target}` : "查看提交详情" };
		case "add":
			return { key: "git-add", label: !target || target === "." ? "暂存全部更改" : `暂存 ${target}` };
		case "commit":
			return { key: "git-commit", label: "提交代码更改" };
		case "push":
			return { key: "git-push", label: "推送代码更改" };
		case "pull":
			return { key: "git-pull", label: "拉取并合并远程更改" };
		case "fetch":
			return { key: "git-fetch", label: "获取远程更新" };
		case "merge":
			return { key: "git-merge", label: target ? `合并分支 ${target}` : "合并分支" };
		case "rebase":
			return { key: "git-rebase", label: target ? `变基到 ${target}` : "变基分支" };
		case "switch":
		case "checkout": {
			const createdBranch = rangeAfterOption(command, rest, new Set(["-b", "-B", "-c", "-C"]));
			const branch = friendlyShellPath(command, createdBranch ?? targetRange, cwd);
			return { key: "git-switch", label: branch ? `切换到 ${branch}` : "切换分支" };
		}
		case "branch":
			if (values.some((value) => value === "-d" || value === "-D" || value === "--delete")) {
				return { key: "git-branch-delete", label: target ? `删除分支 ${target}` : "删除分支" };
			}
			return { key: "git-branch", label: target ? `创建分支 ${target}` : "查看分支" };
		case "restore":
			return values.includes("--staged")
				? { key: "git-unstage", label: target ? `取消暂存 ${target}` : "取消暂存更改" }
				: { key: "git-restore", label: target ? `恢复 ${target}` : "恢复工作区更改" };
		case "reset":
			return { key: "git-reset", label: "重置代码状态" };
		case "stash":
			return { key: "git-stash", label: "管理临时更改" };
		case "worktree": {
			const subcommand = firstPositionalToken(command, rest, new Set())?.range;
			const subcommandText = shellRangeText(command, subcommand).toLowerCase();
			if (subcommandText === "add") return { key: "git-worktree-add", label: "创建工作树" };
			if (subcommandText === "remove" || subcommandText === "prune") return { key: "git-worktree-remove", label: "删除工作树" };
			if (subcommandText === "list") return { key: "git-worktree-list", label: "列出工作树" };
			return { key: "git-worktree", label: "管理工作树" };
		}
		case "clone":
			return { key: "git-clone", label: target ? `克隆仓库 ${friendlyUrlTarget(target)}` : "克隆仓库" };
		case "init":
			return { key: "git-init", label: "初始化仓库" };
		case "grep":
			return { key: "git-grep", label: target ? `搜索仓库：${target}` : "搜索仓库内容" };
		case "ls-files":
			return { key: "git-files", label: "列出版本控制文件" };
		case "rev-parse":
			return { key: "git-rev-parse", label: "查询仓库信息" };
		case "rev-list":
			return { key: "git-rev-list", label: "比较提交范围" };
		case "merge-base":
			return values.includes("--is-ancestor")
				? { key: "git-ancestor", label: "检查分支祖先关系" }
				: { key: "git-merge-base", label: "查找分支共同基点" };
		case "merge-tree":
			return { key: "git-merge-tree", label: "预检分支合并" };
		case "ls-remote":
			return { key: "git-ls-remote", label: "查询远程分支" };
		case "blame":
			return { key: "git-blame", label: "查看代码归属" };
		case "remote":
			return { key: "git-remote", label: "查看远程仓库" };
		case "config":
			return { key: "git-config", label: "查询 Git 配置" };
		case "tag":
			return { key: "git-tag", label: "管理版本标签" };
		case "cherry-pick":
			return { key: "git-cherry-pick", label: "拣选提交" };
		default:
			return { key: `git:${operation}`, label: `执行 Git ${operation}` };
	}
}

function friendlyPackageAction(executable: string, command: string, args: Array<[number, number]>, cwd: string): FriendlyShellAction {
	const action = firstPositionalToken(command, args, new Set([
		"--prefix", "--cache", "--workspace", "-w", "--cwd", "--dir", "--filter", "-C",
	]));
	if (!action) return { key: `${executable}-info`, label: `查询 ${executable} 信息` };
	const operation = shellRangeText(command, action.range);
	const normalized = operation.toLowerCase();
	const rest = args.slice(action.index + 1);
	if (normalized === "run" || normalized === "run-script") {
		const script = firstPositionalToken(command, rest, new Set())?.range;
		return script ? friendlyScriptAction(shellRangeText(command, script)) : { key: "project-script", label: "运行项目脚本" };
	}
	if (normalized === "test") return friendlyTestAction(rest.map((range) => shellRangeText(command, range)), cwd);
	if (normalized === "install" || normalized === "i" || normalized === "ci") return { key: "deps-install", label: "安装项目依赖" };
	if (normalized === "add") return { key: "deps-add", label: "添加项目依赖" };
	if (normalized === "remove" || normalized === "uninstall" || normalized === "rm") return { key: "deps-remove", label: "移除项目依赖" };
	if (normalized === "update" || normalized === "upgrade") return { key: "deps-update", label: "更新项目依赖" };
	if (normalized === "pack" || normalized === "publish") return { key: "project-package", label: normalized === "pack" ? "打包项目" : "发布项目包" };
	if (normalized === "view" || normalized === "info") return { key: "package-info", label: "查询包信息" };
	if (normalized === "exec" || normalized === "x" || normalized === "dlx") {
		const tool = firstPositionalToken(command, rest, new Set())?.range;
		const toolName = shellRangeText(command, tool);
		return friendlyRunnerAction(toolName, rest.map((range) => shellRangeText(command, range)), cwd)
			?? { key: "package-exec", label: toolName ? `运行 ${basename(toolName)}` : "运行包工具" };
	}
	return friendlyScriptAction(operation);
}

function friendlyShellSegmentAction(
	command: string,
	tokens: Array<[number, number]>,
	cwd: string,
	inlineBody = "",
): FriendlyShellAction | undefined {
	const executableIndex = tokens.findIndex((range) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokenText(command, range)));
	if (executableIndex < 0) return undefined;
	const executableSource = shellRangeText(command, tokens[executableIndex]);
	const executableToken = basename(executableSource).toLowerCase();
	const executable = /^\$\{?(?:py|python)\}?$/i.test(executableToken)
		|| /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/.test(executableToken)
		? "python"
		: executableToken;
	const args = tokens.slice(executableIndex + 1);
	const values = args.map((range) => shellRangeText(command, range));
	const firstArg = firstPositionalToken(command, args, new Set())?.range;
	const firstArgText = shellRangeText(command, firstArg);
	const target = friendlyShellTarget(command, args, cwd);

	if (executable.startsWith("-") || executable.startsWith("#") || /\(\)$/.test(executable)
		|| /[(){}$*]/.test(executable) || executable === "!" || executable === "[[" || executable === "]]") {
		return { key: `support:${executable}`, label: `运行 ${executable}`, supporting: true };
	}
	if ([".", "break", "continue", "declare", "exit", "export", "import", "local", "read", "readonly", "return", "shift", "source", "trap", "typeset", "wait"].includes(executable)) {
		return { key: `support:${executable}`, label: `运行 ${executable}`, supporting: true };
	}
	if (executable === "command" && values.includes("-v")) {
		const queried = values.at(-1) ?? "命令";
		return { key: `command-available:${queried}`, label: `检查命令可用性：${basename(queried)}` };
	}
	if (["do", "else", "if", "then", "while"].includes(executable) && args.length > 0) {
		return friendlyShellSegmentAction(command, args, cwd, inlineBody);
	}
	if (executable === "env" || executable === "exec" || executable === "command") {
		const nested = firstPositionalToken(command, args, new Set(["-C", "--chdir", "-u", "--unset", "-S", "--split-string"]));
		if (nested) return friendlyShellSegmentAction(command, args.slice(nested.index), cwd, inlineBody);
		return { key: `support:${executable}`, label: `运行 ${executable}`, supporting: true };
	}
	if (["nohup", "sudo", "time", "timeout", "xargs"].includes(executable)) {
		const known = new Set(["bash", "bun", "cargo", "curl", "docker", "find", "git", "go", "jq", "make", "mypy", "node", "npm", "pi", "playwright-cli", "pnpm", "psql", "pytest", "rg", "ruff", "sh", "tsc", "uv", "vue-tsc", "yarn", "zsh"]);
		const nestedIndex = args.findIndex((range) => {
			const name = basename(shellRangeText(command, range)).toLowerCase();
			return known.has(name)
				|| /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/.test(name)
				|| /\.(?:py|sh|bash|zsh)$/.test(name);
		});
		if (nestedIndex >= 0) return friendlyShellSegmentAction(command, args.slice(nestedIndex), cwd, inlineBody);
	}
	if (/\.py$/i.test(executable)) {
		const scriptName = shellRangeText(command, tokens[executableIndex]);
		return friendlyPythonScriptAction(scriptName, cwd);
	}
	if (/\.(?:sh|bash|zsh)$/i.test(executable)) {
		const scriptName = shellRangeText(command, tokens[executableIndex]);
		return { key: `shell-run:${scriptName}`, label: `运行 Shell 脚本：${friendlyPath(scriptName, cwd)}` };
	}

	if (executable === "git") return friendlyGitAction(command, args, cwd);
	if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "bun") {
		return friendlyPackageAction(executable, command, args, cwd);
	}
	if (executable === "node") {
		if (values.some((value) => value === "--test" || value.startsWith("--test="))) return friendlyTestAction(values, cwd);
		if (values.includes("--check")) {
			const target = friendlyTargetSummary(values, cwd);
			return { key: "node-check", label: target ? `检查 JavaScript 语法：${target}` : "检查 JavaScript 语法" };
		}
		const inline = shellRangeText(command, rangeAfterOption(command, args, new Set(["-e", "--eval", "-p", "--print"])));
		if (inline) return friendlyInlineScriptAction("node", inline);
		const script = firstPositionalToken(command, args, new Set(["--input-type", "--require", "-r", "--loader", "--import", "--conditions", "-e", "--eval", "-p", "--print"]))?.range;
		const scriptName = shellRangeText(command, script);
		if (scriptName && scriptName !== "-") {
			return { key: `node-script:${scriptName}`, label: `运行 Node.js 脚本：${friendlyPath(scriptName, cwd)}` };
		}
		return friendlyInlineScriptAction("node", inlineBody);
	}
	if (executable === "python" || executable === "python3") {
		let moduleName = "";
		let inlineCommand = "";
		let readsStdin = false;
		let script: IndexedTokenRange | undefined;
		for (let index = 0; index < args.length; index += 1) {
			const value = shellRangeText(command, args[index]);
			if (value === "-W" || value === "-X") {
				index += 1;
				continue;
			}
			if (value === "-m") {
				moduleName = shellRangeText(command, args[index + 1]);
				break;
			}
			if (value === "-c") {
				inlineCommand = shellRangeText(command, args[index + 1]);
				break;
			}
			if (value === "-") {
				readsStdin = true;
				break;
			}
			if (value === "--") {
				const nextValue = shellRangeText(command, args[index + 1]);
				if (nextValue === "-") readsStdin = true;
				else if (args[index + 1]) script = { index: index + 1, range: args[index + 1] };
				break;
			}
			if (value.startsWith("-")) continue;
			script = { index, range: args[index] };
			break;
		}
		if (moduleName === "pytest" || moduleName === "unittest") return friendlyTestAction(values, cwd);
		if (moduleName === "py_compile" || moduleName === "compileall") {
			const target = friendlyTargetSummary(values, cwd);
			return { key: "python-syntax", label: target ? `检查 Python 语法：${target}` : "检查 Python 语法" };
		}
		const moduleRunner = friendlyRunnerAction(moduleName, values, cwd);
		if (moduleRunner) return moduleRunner;
		if (moduleName === "http.server") return { key: "local-web-server", label: "启动本地网页服务" };
		if (moduleName) return { key: `python-module:${moduleName}`, label: `运行 Python 模块 ${moduleName}` };
		if (inlineCommand) return friendlyInlineScriptAction("python", inlineCommand);
		const scriptName = shellRangeText(command, script?.range);
		if (scriptName) return friendlyPythonScriptAction(scriptName, cwd);
		return friendlyInlineScriptAction("python", readsStdin ? inlineBody : "");
	}
	if (executable === "uv") {
		const action = firstPositionalToken(command, args, new Set(["--directory", "--project", "--python", "--extra", "--with", "--index", "--index-url"]));
		const operation = shellRangeText(command, action?.range).toLowerCase();
		const rest = action ? args.slice(action.index + 1) : [];
		if (operation === "run") {
			const runner = firstPositionalToken(command, rest, new Set(["--directory", "--project", "--python", "--extra", "--with"]));
			const runnerName = shellRangeText(command, runner?.range);
			const restValues = rest.map((range) => shellRangeText(command, range));
			if (/^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/.test(basename(runnerName).toLowerCase()) && runner) {
				return friendlyShellSegmentAction(command, rest.slice(runner.index), cwd, inlineBody);
			}
			if (/\.py$/i.test(runnerName)) {
				return friendlyPythonScriptAction(runnerName, cwd);
			}
			return friendlyRunnerAction(runnerName, restValues, cwd)
				?? { key: "uv-run", label: runnerName ? `运行 ${basename(runnerName)}` : "运行 Python 环境" };
		}
		if (operation === "sync") return { key: "python-deps-sync", label: "同步 Python 依赖" };
		if (operation === "add") return { key: "python-deps-add", label: "添加 Python 依赖" };
		if (operation === "remove") return { key: "python-deps-remove", label: "移除 Python 依赖" };
		if (operation === "lock") return { key: "python-deps-lock", label: "更新 Python 依赖锁" };
		return { key: "uv", label: operation ? `执行 uv ${operation}` : "管理 Python 环境" };
	}
	const runnerAction = friendlyRunnerAction(executable, values, cwd);
	if (runnerAction) return runnerAction;
	if (executable === "cargo" || executable === "go") {
		const operation = firstArgText.toLowerCase();
		if (operation === "test") return { key: "project-test", label: "运行项目测试" };
		if (operation === "check" || operation === "clippy" || operation === "vet") return { key: "project-check", label: "检查代码质量" };
		if (operation === "fmt" || operation === "format") return { key: "project-format", label: "格式化代码" };
		if (operation === "build") return { key: "project-build", label: "构建项目" };
		return { key: `${executable}:${operation}`, label: operation ? `执行 ${executable} ${operation}` : `运行 ${executable}` };
	}
	if (executable === "tsc") return { key: "project-types", label: "检查项目类型" };
	if (executable === "eslint") return { key: "project-lint", label: "检查代码规范" };
	if (executable === "prettier" || executable === "biome") {
		return values.includes("--check") || values.includes("check")
			? { key: "project-format-check", label: "检查代码格式" }
			: { key: "project-format", label: "格式化代码" };
	}
	if (executable === "make") {
		const task = firstPositionalToken(command, args, new Set(["-C", "-f", "--file", "--directory"]))?.range;
		const taskName = shellRangeText(command, task);
		return taskName
			? { key: `make-target:${taskName}`, label: `运行 Make 目标：${compactText(taskName, 36)}` }
			: { key: "make", label: "运行 Make" };
	}
	if (executable === "rg" || executable === "grep") {
		if (values.some((value) => value === "--files" || value.startsWith("--files="))) return { key: "list-project-files", label: "列出项目文件" };
		const valueOptions = new Set([
			"-A", "--after-context", "-B", "--before-context", "-C", "--context", "--color", "--colors",
			"--dfa-size-limit", "-E", "--encoding", "--engine", "-f", "--file", "-g", "--glob", "--iglob",
			"--ignore-file", "--include", "--exclude", "--exclude-from", "--exclude-dir", "--label",
			"-m", "--max-count", "--max-columns", "--path-separator", "-r", "--replace", "--regex-size-limit",
			"--sort", "--sortr", "-t", "--type", "--type-add", "--type-clear",
		]);
		const used = new Set<number>();
		const patterns: string[] = [];
		for (let index = 0; index < args.length; index += 1) {
			const value = shellRangeText(command, args[index]);
			if (value === "-e" || value === "--regexp") {
				used.add(index);
				if (args[index + 1]) {
					used.add(index + 1);
					patterns.push(shellRangeText(command, args[index + 1]));
					index += 1;
				}
				continue;
			}
			if (value.startsWith("--regexp=")) {
				used.add(index);
				patterns.push(value.slice("--regexp=".length));
				continue;
			}
			if (/^-e.+/.test(value)) {
				used.add(index);
				patterns.push(value.slice(2));
				continue;
			}
			if (valueOptions.has(value)) {
				used.add(index);
				if (args[index + 1]) used.add(++index);
				continue;
			}
			if ([...valueOptions].some((option) => option.startsWith("--") && value.startsWith(`${option}=`))) used.add(index);
		}
		const positional = args
			.map((range, index) => ({ index, value: shellRangeText(command, range) }))
			.filter(({ index, value }) => !used.has(index) && value !== "--" && (!value.startsWith("-") || args[index - 1] && shellRangeText(command, args[index - 1]) === "--"));
		if (patterns.length === 0 && positional.length > 0) patterns.push(positional.shift()?.value ?? "");
		const scopes = positional
			.map(({ value }) => value)
			.filter((value) => value && value !== "-" && !/^(?:\d*(?:>>?|<<?|>&|<&))/.test(value));
		const patternText = compactText(patterns.filter(Boolean).join("｜"), 42);
		const firstScope = scopes[0] ? friendlyPath(scopes[0], cwd, scopes[0]) : "";
		const scopeText = firstScope ? `${firstScope}${scopes.length > 1 ? ` 等 ${scopes.length} 处` : ""}` : "";
		const label = patternText
			? scopeText ? `在 ${scopeText} 搜索：${patternText}` : `搜索代码：${patternText}`
			: scopeText ? `在 ${scopeText} 搜索代码` : "搜索代码内容";
		return { key: `${executable}-search:${patternText}:${scopeText}`, label };
	}
	if (executable === "find") {
		const pattern = rangeAfterOption(command, args, new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"]));
		const patternText = compactText(shellRangeText(command, pattern), 36);
		const root = firstPositionalToken(command, args, new Set())?.range;
		const rootText = friendlyShellPath(command, root, cwd);
		return {
			key: `find:${patternText}:${rootText}`,
			label: patternText
				? rootText ? `在 ${rootText} 查找文件：${patternText}` : `查找文件：${patternText}`
				: rootText ? `在 ${rootText} 查找文件` : "查找文件",
		};
	}
	if (executable === "test" || executable === "[") {
		if (values.includes("-d")) return { key: "test-directory", label: "检查目录状态" };
		if (values.some((value) => value === "-e" || value === "-f" || value === "-r" || value === "-w")) return { key: "test-file", label: "检查文件状态" };
		return { key: "shell-test", label: "检查命令条件" };
	}
	if (executable === "lock") return { key: "coordination-lock", label: "获取协调锁" };
	if (executable === "jq") return { key: "jq", label: "处理 JSON 数据" };
	if (executable === "npx" || executable === "uvx") {
		const packageTool = firstPositionalToken(command, args, new Set(["--package", "-p", "--call", "-c", "--cache", "--from", "--python", "--with"]))?.range;
		const packageToolName = shellRangeText(command, packageTool);
		if (packageToolName === "skills") return { key: "agent-skills", label: "管理 Agent 技能" };
		return friendlyRunnerAction(packageToolName, values, cwd)
			?? { key: executable, label: packageToolName ? `运行 ${packageToolName}` : `运行 ${executable}` };
	}
	if (executable === "psql" || executable === "sqlite3" || executable === "mysql") return { key: "database-query", label: "查询数据库" };
	if (executable === "pip" || executable === "pip3") {
		return firstArgText === "install"
			? { key: "python-package-install", label: "安装 Python 包" }
			: { key: "python-package", label: "管理 Python 包" };
	}
	if (executable === "which" || executable === "whereis") {
		return { key: "command-location", label: `查找命令：${basename(firstArgText) || "命令"}` };
	}
	if (executable === "dig" || executable === "host" || executable === "nslookup") {
		const dnsTarget = values.find((value) => !value.startsWith("-") && !value.startsWith("@") && /[A-Za-z]/.test(value));
		return { key: "dns-query", label: dnsTarget ? `查询 DNS：${compactText(dnsTarget, 40)}` : "查询 DNS" };
	}
	if (executable === "curl" || executable === "wget") {
		const url = args.find((range) => /^https?:\/\//.test(shellRangeText(command, range)));
		const urlTarget = friendlyUrlTarget(shellRangeText(command, url));
		return { key: "network-request", label: urlTarget ? `请求网络资源：${urlTarget}` : "请求网络资源" };
	}
	if (executable === "cp") return { key: "copy", label: target ? `复制到 ${target}` : "复制文件" };
	if (executable === "ln") return { key: "symlink", label: target ? `创建链接 ${target}` : "创建文件链接" };
	if (executable === "rsync") return { key: "sync", label: target ? `同步到 ${target}` : "同步文件" };
	if (executable === "mv") return { key: "move", label: target ? `移动到 ${target}` : "移动文件" };
	if (executable === "rm" || executable === "rmdir") return { key: "remove", label: target ? `删除 ${target}` : "删除文件" };
	if (executable === "mkdir") return { key: "mkdir", label: target ? `创建目录 ${target}` : "创建目录" };
	if (executable === "touch") return { key: "touch", label: target ? `创建文件 ${target}` : "创建文件" };
	if (executable === "cat" || executable === "less" || executable === "nl") {
		const redirectIndex = values.findIndex((value) => /^1?>>?(?!&)/.test(value));
		if (executable === "cat" && redirectIndex >= 0) {
			const redirectedPath = values[redirectIndex + 1];
			return { key: "shell-write", label: redirectedPath ? `写入 ${friendlyPath(redirectedPath, cwd, redirectedPath)}` : "写入文件" };
		}
		const verb = /\.(?:log|out)$/i.test(target) ? "查看日志" : "读取";
		return { key: "read-file", label: target ? `${verb} ${target}` : "读取文件" };
	}
	if (executable === "tail" || executable === "head") {
		const verb = /\.(?:log|out)$/i.test(target) ? "查看日志" : "查看文件末尾";
		return { key: `support:${executable}`, label: target ? `${verb} ${target}` : `运行 ${executable}`, supporting: true };
	}
	if (executable === "ls") return { key: "list-directory", label: target ? `列出 ${target}` : "列出目录内容" };
	if (executable === "wc") return { key: "file-count", label: "统计文件内容" };
	if (executable === "ps" || executable === "pgrep" || executable === "lsof") return { key: "process-status", label: "检查进程状态" };
	if (executable === "kill" || executable === "pkill") return { key: "process-stop", label: "停止进程" };
	if (executable === "date") return { key: "system-time", label: "查看系统时间" };
	if (executable === "pdftotext" || executable === "pdfinfo") return { key: "pdf-inspect", label: target ? `检查 PDF ${target}` : "检查 PDF" };
	if (executable === "unzip") return { key: "archive-inspect", label: target ? `检查压缩包 ${target}` : "检查压缩包" };
	if (executable === "file" || executable === "stat" || executable === "du") return { key: "file-info", label: target ? `检查文件信息 ${target}` : "检查文件信息" };
	if (executable === "apply_patch" || executable === "patch" || executable === "perl" && values.includes("-pi")) return { key: "batch-edit", label: "批量修改文件" };
	if (executable === "diff") return values.includes("--check") ? { key: "diff-check", label: "检查差异格式" } : { key: "diff", label: "比较文件差异" };
	if (executable === "dwgread") return { key: "cad-inspect", label: "检查 CAD 文件" };
	if (executable === "security") return { key: "keychain", label: "检查系统钥匙串" };
	if (executable === "ssh") return { key: "ssh", label: "检查远程主机" };
	if (executable === "shasum" || executable === "sha256sum") return { key: "checksum", label: target ? `校验 ${target}` : "校验文件一致性" };
	if (executable === "playwright-cli") {
		const operation = firstPositionalToken(command, args, new Set(["-s", "--session", "--timeout"]));
		const action = shellRangeText(command, operation?.range);
		const browserLabels: Record<string, string> = {
			click: "点击网页元素",
			close: "关闭浏览器",
			console: "查看浏览器控制台",
			eval: "在浏览器执行脚本",
			fill: "填写网页表单",
			find: "定位网页元素",
			list: "列出浏览器会话",
			open: "打开网页",
			goto: "打开网页",
			press: "操作网页键盘",
			reload: "刷新网页",
			requests: "查看网页网络请求",
			resize: "调整浏览器窗口",
			"run-code": "在浏览器执行脚本",
			screenshot: "检查网页",
			select: "选择网页选项",
			snapshot: "检查网页",
			"tab-close": "关闭浏览器标签页",
			"tab-new": "打开浏览器标签页",
			"tab-select": "切换浏览器标签页",
		};
		return {
			key: `browser:${action || "action"}`,
			label: browserLabels[action] ?? (action ? `操作浏览器：${action}` : "操作浏览器"),
			supporting: action === "resize",
		};
	}
	if (executable === "gh") {
		const operation = firstArgText.toLowerCase();
		const subcommand = firstPositionalToken(command, args, new Set(), 1)?.range;
		const subcommandText = shellRangeText(command, subcommand).toLowerCase();
		if (operation === "api") return { key: "github-api", label: "查询 GitHub API" };
		if (operation === "repo") return { key: "github-repo", label: subcommandText === "list" ? "列出 GitHub 仓库" : "查看 GitHub 仓库" };
		if (operation === "pr") return { key: `github-pr:${subcommandText}`, label: subcommandText === "create" ? "创建拉取请求" : subcommandText === "list" ? "列出拉取请求" : "查看拉取请求" };
		if (operation === "issue") return { key: `github-issue:${subcommandText}`, label: subcommandText === "create" ? "创建 GitHub Issue" : subcommandText === "list" ? "列出 GitHub Issue" : "查看 GitHub Issue" };
		return { key: "github", label: operation ? `操作 GitHub：${operation}` : "操作 GitHub" };
	}
	if (executable === "docker") {
		const operation = firstArgText.toLowerCase();
		const subcommand = firstPositionalToken(command, args, new Set(), 1)?.range;
		const action = operation === "compose" ? shellRangeText(command, subcommand).toLowerCase() : operation;
		if (action === "ps") return { key: "container-status", label: "检查容器状态" };
		if (action === "up" || action === "start") return { key: "container-start", label: "启动容器服务" };
		if (action === "down" || action === "stop") return { key: "container-stop", label: "停止容器服务" };
		if (action === "build") return { key: "container-build", label: "构建容器镜像" };
		return { key: "container-manage", label: "管理容器服务" };
	}
	if (executable === "tmux") {
		if (firstArgText === "capture-pane") return { key: "tmux-capture", label: "检查后台会话输出" };
		if (firstArgText === "list-sessions" || firstArgText === "ls") return { key: "tmux-list", label: "列出后台会话" };
		return { key: "tmux", label: "管理后台会话" };
	}
	if (executable === "pi") {
		if (values.includes("--list-models")) return { key: "pi-models", label: "查询可用模型" };
		if (values.includes("--version") || values.includes("-v")) return { key: "pi-version", label: "查看 Pi 版本" };
		if (values.includes("--help") || values.includes("-h")) return { key: "pi-help", label: "查看 Pi 帮助" };
		if (values.includes("list")) return { key: "pi-list", label: "列出 Pi 扩展" };
		if (values.includes("install")) return { key: "pi-install", label: "安装 Pi 扩展" };
		if (values.includes("update")) return { key: "pi-update", label: "更新 Pi 扩展" };
		if (values.some((value) => value === "-p" || value === "--print" || value === "--session-dir")) {
			return { key: "pi-session", label: "运行 Pi 自动化会话" };
		}
		return { key: "pi", label: "运行 Pi" };
	}
	if (executable === "bash" || executable === "sh" || executable === "zsh") {
		if (values.includes("-n")) {
			const syntaxTarget = friendlyTargetSummary(values, cwd);
			return { key: "shell-syntax", label: syntaxTarget ? `检查 Shell 语法：${syntaxTarget}` : "检查 Shell 语法" };
		}
		const commandMode = values.some((value) => value === "--command" || /^-[^-]*c[^/]*$/.test(value));
		if (commandMode) return { key: "shell-inline", label: "执行 Shell 命令" };
		return firstArgText
			? { key: `shell-run:${firstArgText}`, label: `运行 Shell 脚本：${friendlyPath(firstArgText, cwd)}` }
			: { key: "shell-inline", label: "执行内联 Shell" };
	}
	if (executable === "ruby" || executable === "perl") {
		const runtime = executable === "ruby" ? "Ruby" : "Perl";
		const inline = values.some((value) => executable === "ruby" ? /^-[^-]*e/.test(value) : /^-[^-]*[eE]/.test(value));
		if (inline) return { key: `${executable}-inline`, label: `执行内联 ${runtime}` };
		return firstArgText
			? { key: `${executable}-script:${firstArgText}`, label: `运行 ${runtime} 脚本：${friendlyPath(firstArgText, cwd)}` }
			: { key: `${executable}-inline`, label: `执行内联 ${runtime}` };
	}
	if (executable === "expect") {
		return values.includes("-c")
			? { key: "expect-inline", label: "执行内联 Expect" }
			: firstArgText
				? { key: `expect-script:${firstArgText}`, label: `运行 Expect 脚本：${friendlyPath(firstArgText, cwd)}` }
				: { key: "expect", label: "运行 Expect" };
	}
	if (executable === "sed") return values.some((value) => /^-[^-]*i/.test(value))
		? { key: "batch-edit", label: "批量修改文件" }
		: { key: "text-filter", label: "筛选文本内容" };
	if (executable === "awk") return { key: "text-analysis", label: "分析文本数据" };
	if (["cd", "pushd", "popd", "pwd", "sleep", "echo", "printf", "sort", "uniq", "tee", "set", "for", "do", "done", "if", "then", "else", "fi", "while", "case", "esac", "{", "}", ":", "true", "false"].includes(executable)) {
		return { key: `support:${executable}`, label: `运行 ${executable}`, supporting: true };
	}
	if (/[\\/]/.test(executableSource) && !/[{}()*$]/.test(executableSource)) {
		return { key: `executable-script:${executableSource}`, label: `运行可执行脚本：${friendlyPath(executableSource, cwd)}` };
	}
	return { key: `command:${executable}`, label: `运行 ${executable || "命令"}` };
}

function bashActionLabel(command: unknown, cwd: string): string | undefined {
	if (typeof command !== "string" || !command.trim()) return undefined;
	const source = prepareFriendlyShellSource(command);
	const normalized = source.command;
	const actions = shellCommandTokenRanges(normalized)
		.map((tokens) => friendlyShellSegmentAction(normalized, tokens, cwd, source.inlineBody))
		.filter((action): action is FriendlyShellAction => Boolean(action));
	const substantive = actions.filter((action) => !action.supporting);
	if (substantive.length === 0 && actions.some((action) => action.key === "support:echo" || action.key === "support:printf")) return "输出命令信息";
	const qualityKeys = new Set([
		"git-diff-check", "node-check", "project-build", "project-format-check", "project-lint", "project-test",
		"project-types", "python-syntax", "python-types", "shell-syntax",
	]);
	const baseSelected = substantive.length > 0 ? substantive : actions;
	const qualitySupportKeys = new Set(["file-count", "node-inline", "python-inline", "read-file", "text-filter"]);
	const selected = baseSelected.some((action) => qualityKeys.has(action.key))
		? baseSelected.filter((action) => !qualitySupportKeys.has(action.key))
		: baseSelected;
	const unique = selected.filter((action, index) => selected.findIndex((candidate) => candidate.key === action.key && candidate.label === action.label) === index);
	if (unique.length >= 2 && unique.every((action) => qualityKeys.has(action.key))) {
		const checks = [
			unique.some((action) => action.key === "project-test") ? "测试" : "",
			unique.some((action) => /(?:types|syntax|check)$/.test(action.key) && action.key !== "git-diff-check") ? "类型/语法" : "",
			unique.some((action) => /(?:lint|format|diff-check)$/.test(action.key)) ? "规范" : "",
			unique.some((action) => action.key === "project-build") ? "构建" : "",
		].filter(Boolean);
		return `运行项目检查：${checks.join("、")}`;
	}
	if (unique.length >= 2 && unique.every((action) => action.key.startsWith("browser:"))) {
		const inspects = unique.some((action) => action.key === "browser:snapshot" || action.key === "browser:screenshot");
		const opens = unique.some((action) => action.key === "browser:open" || action.key === "browser:goto");
		if (inspects && opens) return "打开并检查网页";
		if (inspects) return "操作并检查网页";
	}
	const repositoryInspectionKeys = new Set(["git-status", "git-log", "git-show", "git-diff", "git-diff-check", "git-diff-summary", "git-branch", "git-worktree-list", "git-rev-parse"]);
	if (unique.length >= 2 && unique.every((action) => repositoryInspectionKeys.has(action.key))) return "检查仓库状态与变更";
	const hasCommit = unique.some((action) => action.key === "git-commit");
	const hasPush = unique.some((action) => action.key === "git-push");
	const combined = hasCommit && hasPush
		? unique.reduce<FriendlyShellAction[]>((result, action) => {
			if (action.key === "git-add") return result;
			if (action.key !== "git-commit" && action.key !== "git-push") return [...result, action];
			if (result.some((item) => item.key === "git-commit-push")) return result;
			return [...result, { key: "git-commit-push", label: "提交并推送代码更改" }];
		}, [])
		: unique;
	if (combined.length <= 2) return combined.map((action) => action.label).join("；") || undefined;
	return `${combined[0].label}；${combined[1].label}；另 ${combined.length - 2} 项`;
}

function friendlyBashLabel(command: unknown, cwd: string): string {
	if (typeof command !== "string" || !command.trim()) return "运行命令";
	return bashActionLabel(command, cwd) ?? (() => {
		const normalized = prepareFriendlyShellSource(command).command;
		const range = firstShellCommandRange(normalized);
		const executable = range ? basename(normalized.slice(range[0], range[1])) : "命令";
		return `运行 ${executable}`;
	})();
}

function friendlyToolSummary(instance: MinimalToolExecutionInstance): MinimalToolSummary {
	const args = instance.args ?? {};
	const toolName = instance.toolName.split(".").at(-1) ?? instance.toolName;
	const path = friendlyPath(args.path ?? args.file_path, instance.cwd);
	let label: string;
	switch (toolName) {
		case "bash":
			label = friendlyBashLabel(args.command, instance.cwd);
			break;
		case "read": {
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const verb = offset !== undefined && offset > 1 ? "续读" : friendlyFileVerb(path, "read");
			const specialDocument = /^(?:读取技能说明|读取项目规则|读取项目上下文|读取工作流说明)$/.test(verb);
			const displayPath = specialDocument ? friendlyPathTail(path) : path;
			const range = offset !== undefined && offset > 1
				? `（${offset}${limit !== undefined ? `–${offset + limit - 1}` : " 起"} 行）`
				: "";
			label = `${verb} ${displayPath}${range}`;
			break;
		}
		case "edit": {
			const count = Array.isArray(args.edits) ? args.edits.length : 0;
			label = `${friendlyFileVerb(path, "edit")} ${path}${count ? `（${count} 处）` : ""}`;
			break;
		}
		case "write":
			label = `${friendlyFileVerb(path, "write")} ${path}`;
			break;
		case "grep": {
			const scope = friendlyPath(args.path, instance.cwd, "工作区");
			label = `在 ${scope} 搜索 ${compactText(args.pattern, 36) || "内容"}`;
			break;
		}
		case "find": {
			const scope = friendlyPath(args.path, instance.cwd, "工作区");
			label = `在 ${scope} 查找 ${compactText(args.pattern, 36) || "文件"}`;
			break;
		}
		case "ls":
			label = `列出 ${friendlyPath(args.path, instance.cwd, "工作区")}`;
			break;
		case "web_search": {
			const singleQuery = friendlyFirstString(args.query);
			const query = singleQuery.value ? singleQuery : friendlyFirstString(args.queries);
			label = query.count > 1
				? `搜索网络（${query.count} 项）：${compactText(query.value, 52)}`
				: `搜索网络：${compactText(query.value, 52) || "网络信息"}`;
			break;
		}
		case "source_check":
			label = `核验事实：${compactText(args.claim, 64) || "待核验内容"}`;
			break;
		case "fetch_content": {
			const singleSource = friendlyFirstString(args.url);
			const sources = singleSource.value ? singleSource : friendlyFirstString(args.urls);
			const target = friendlyUrlTarget(sources.value) || "内容";
			const targetWithCount = sources.count > 1 ? `（${sources.count} 项）：${target}` : `：${target}`;
			if (typeof args.timestamp === "string" && args.timestamp) label = `提取视频画面 ${args.timestamp}${targetWithCount}`;
			else if (args.mode === "answer" || typeof args.prompt === "string" && args.prompt.trim()) label = `分析网页内容${targetWithCount}`;
			else if (args.mode === "raw") label = `获取原始内容${targetWithCount}`;
			else label = `获取网页内容${targetWithCount}`;
			break;
		}
		case "get_search_content": {
			const findText = friendlyFirstString(args.findText);
			const url = friendlyFirstString(args.url).value;
			const query = friendlyFirstString(args.query).value;
			if (findText.value) label = `在来源中查找：${compactText(findText.value, 56)}`;
			else if (typeof args.offset === "number" && args.offset > 0) label = "继续读取来源内容";
			else if (url) label = `读取来源：${friendlyUrlTarget(url)}`;
			else if (query) label = `读取搜索结果：${compactText(query, 52)}`;
			else if (typeof args.urlIndex === "number") label = `读取来源 #${args.urlIndex + 1}`;
			else if (typeof args.queryIndex === "number") label = `读取搜索结果 #${args.queryIndex + 1}`;
			else label = "读取搜索结果";
			break;
		}
		case "set_ctx_title":
			label = typeof args.title === "string" ? `设置会话名：${compactText(args.title, 64)}` : "清除会话名";
			break;
		case "parallel": {
			const uses = Array.isArray(args.tool_uses) ? args.tool_uses : [];
			const names = uses.map((use) => {
				if (!use || typeof use !== "object" || !("recipient_name" in use)) return "";
				const name = (use as { recipient_name?: unknown }).recipient_name;
				return typeof name === "string" ? name.split(".").at(-1) ?? name : "";
			}).filter(Boolean);
			label = names.length > 0 && names.every((name) => name === "read")
				? `并行读取 ${names.length} 个文件`
				: `并行执行 ${uses.length || names.length} 项操作`;
			break;
		}
		case "task":
		case "agent":
		case "subagent":
			label = `委派子任务${typeof args.description === "string" ? `：${compactText(args.description, 52)}` : ""}`;
			break;
		default: {
			const preview = compactText(minimalArgumentPreview(args), 44);
			label = `执行 ${instance.toolName}${preview ? `：${preview}` : ""}`;
		}
	}
	return { label: compactText(label, MAX_FRIENDLY_SUMMARY_LENGTH), detail: "" };
}

function friendlyLabelKeywordRanges(label: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const match of label.matchAll(/[^；]+/g)) {
		const rawClause = match[0];
		const leading = rawClause.length - rawClause.trimStart().length;
		const clause = rawClause.trim();
		if (!clause || /^另 \d+ 项$/.test(clause)) continue;
		const clauseStart = (match.index ?? 0) + leading;
		const scopedAction = clause.match(/^在 .+? (搜索代码|搜索|查找文件|查找)(?=：|\s|$)/);
		if (scopedAction) {
			const keyword = scopedAction[1];
			const start = clauseStart + scopedAction[0].lastIndexOf(keyword);
			ranges.push([start, start + keyword.length]);
			continue;
		}
		const colon = clause.indexOf("：");
		if (colon >= 0) {
			let keyword = clause.slice(0, colon).replace(/（\d+ 项）$/, "");
			if (keyword.startsWith("提取视频画面 ")) keyword = "提取视频画面";
			if (keyword) ranges.push([clauseStart, clauseStart + keyword.length]);
			continue;
		}
		const keyword = clause.match(/^\S+/)?.[0] ?? "";
		if (keyword) ranges.push([clauseStart, clauseStart + keyword.length]);
	}
	return ranges;
}

function styleFriendlyToolLabel(label: string, theme: FooterTheme | undefined, running: boolean): string {
	const ranges = friendlyLabelKeywordRanges(label);
	const styleNormal = (text: string) => theme?.fg(running ? "toolTitle" : "toolOutput", text)
		?? `${ANSI_DIM}${text}${ANSI_STYLE_RESET}`;
	if (ranges.length === 0) return styleNormal(label);
	const parts: string[] = [];
	let cursor = 0;
	for (const [start, end] of ranges) {
		parts.push(styleNormal(label.slice(cursor, start)));
		parts.push(riffHighlight(label.slice(start, end), "success", true, theme));
		cursor = end;
	}
	parts.push(styleNormal(label.slice(cursor)));
	return parts.join("");
}

function styleMinimalToolDetail(summary: MinimalToolSummary, theme: FooterTheme | undefined): string {
	if (!summary.detail) return "";
	const ranges = summary.emphasizedDetailRanges
		?? (summary.emphasizedDetailRange ? [summary.emphasizedDetailRange] : []);
	if (ranges.length === 0) return theme?.fg("toolOutput", summary.detail) ?? summary.detail;

	const styleNormal = (text: string) => theme?.fg("toolOutput", text) ?? text;
	const styledParts: string[] = [];
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start < cursor || end <= start) continue;
		styledParts.push(styleNormal(summary.detail.slice(cursor, start)));
		styledParts.push(riffHighlight(summary.detail.slice(start, end), "success", true, theme));
		cursor = end;
	}
	styledParts.push(styleNormal(summary.detail.slice(cursor)));
	return styledParts.join("");
}

function trackMinimalToolAnimation(instance: MinimalToolExecutionInstance): void {
	const state = minimalToolDisplayState();
	if (instance.isPartial) state.runningTools.add(instance);
	else state.runningTools.delete(instance);
	if (state.animationTimer !== undefined || state.runningTools.size === 0) return;

	state.animationTimer = setInterval(() => {
		for (const tool of state.runningTools) {
			if (tool.isPartial) tool.ui.requestRender();
			else state.runningTools.delete(tool);
		}
		if (state.runningTools.size > 0) return;
		if (state.animationTimer !== undefined) clearInterval(state.animationTimer);
		state.animationTimer = undefined;
	}, 120);
}

function stopMinimalToolAnimation(): void {
	const state = minimalToolDisplayState();
	if (state.animationTimer !== undefined) clearInterval(state.animationTimer);
	state.animationTimer = undefined;
	state.runningTools.clear();
}

function renderedToolDuration(instance: MinimalToolExecutionInstance, width: number): string | undefined {
	const durationMs = instance.result?.durationMs;
	if (durationMs !== undefined && Number.isFinite(durationMs)) return formatDuration(durationMs);
	const line = instance.callRendererComponent?.render(Math.max(1, width))
		.find((candidate) => visibleWidth(candidate) > 0);
	if (!line) return undefined;
	const plain = line.replace(ANSI_SGR, "");
	return plain.match(/\b(?:Took|Elapsed)\s+([0-9.]+(?:ms|s)|\d+m(?:\s+[0-9.]+s)?|\d+h[^ ]*)/)?.[1];
}

function renderMinimalTool(instance: MinimalToolExecutionInstance, width: number): string[] {
	if (width <= 0) return [];
	const padding = Math.min(Math.max(0, Math.floor(instance.outputPad ?? 1)), Math.floor((width - 1) / 2));
	const contentWidth = width - padding * 2;
	const margin = " ".repeat(padding);
	return renderMinimalToolBody(instance, contentWidth).map((line) =>
		margin + truncateToWidth(line, contentWidth, "", false) + margin);
}

function renderMinimalToolBody(instance: MinimalToolExecutionInstance, width: number): string[] {
	const theme = footerTimerState().getTheme?.();
	const toolState = minimalToolDisplayState();
	instance.customPiToolGroup ??= toolState.groupGeneration;
	trackMinimalToolAnimation(instance);
	const toolSummary = toolState.displayMode === "friendly"
		? friendlyToolSummary(instance)
		: minimalToolSummary(instance);
	const spinnerFrame = SPINNER_GLYPHS[Math.floor(performance.now() / 120) % SPINNER_GLYPHS.length];
	const runningMarker = instance.isPartial
		? `${riffHighlight(spinnerFrame, "success", false, theme)} `
		: "";
	const styledLabel = toolState.displayMode === "friendly"
		? styleFriendlyToolLabel(toolSummary.label, theme, instance.isPartial)
		: riffHighlight(toolSummary.label, "success", true, theme);
	const styledDetail = toolSummary.detail ? ` ${styleMinimalToolDetail(toolSummary, theme)}` : "";
	const duration = instance.isPartial ? undefined : renderedToolDuration(instance, width);
	const fact = toolState.displayMode === "command"
		? minimalToolFact(instance)
		: toolState.displayMode === "friendly" ? friendlyToolFact(instance) : "";
	const contentWidth = Math.max(1, width - visibleWidth(runningMarker));
	const minimumSummaryWidth = Math.min(contentWidth, Math.max(8, visibleWidth(styledLabel)));
	const fitsMetadata = (value: string): boolean =>
		!value || visibleWidth(value) + minimumSummaryWidth + 2 <= contentWidth;
	let metadata = [fact, duration].filter(Boolean).join("  ");
	if (!fitsMetadata(metadata)) metadata = duration ?? "";
	if (!fitsMetadata(metadata)) metadata = "";
	const styledMetadata = metadata ? theme?.fg("muted", metadata) ?? metadata : "";
	const metadataWidth = visibleWidth(styledMetadata);
	const metadataGap = metadataWidth > 0 ? 2 : 0;
	const summaryWidth = Math.max(1, contentWidth - metadataWidth - metadataGap);
	const ellipsis = theme?.fg("muted", "...") ?? "...";
	const summary = truncateMiddleToWidth(styledLabel + styledDetail, summaryWidth, ellipsis);
	const padding = metadataWidth > 0
		? " ".repeat(Math.max(metadataGap, contentWidth - visibleWidth(summary) - metadataWidth))
		: "";
	const line = runningMarker + summary + padding + styledMetadata;
	const lines = [line];

	if (instance.result?.isError) {
		const error = genericErrorText(instance);
		if (error) {
			const errorText = theme?.fg("error", error) ?? error;
			const indent = Math.min(2, Math.max(0, width - 1));
			lines.push(" ".repeat(indent) + truncateToWidth(errorText, width - indent, "...", false));
		}
	}
	return lines;
}

function compactTimingEntrySpacing(component: Component): void {
	const customEntry = component as Component & {
		children?: Component[];
		entry?: { customType?: string };
	};
	if (customEntry.entry?.customType !== AGENT_TIMING_ENTRY || !customEntry.children) return;
	if (customEntry.children[0] instanceof Spacer) customEntry.children.shift();
}

function installTimingEntrySpacing(): void {
	const prototype = Container.prototype as unknown as ContainerPrototype;
	if (prototype.customPiTimingEntrySpacingPatched) return;
	const renderContainer = prototype.render;
	prototype.render = function (width) {
		const instance = this as unknown as { children?: Component[] };
		for (const child of instance.children ?? []) compactTimingEntrySpacing(child);
		return renderContainer.call(this, width);
	};
	Object.defineProperty(prototype, "customPiTimingEntrySpacingPatched", {
		value: true,
		configurable: false,
		writable: false,
	});
}

function installToolDisplayModeCycling(): void {
	const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
	if (prototype.customPiToolModeCyclingPatched) return;

	prototype.toggleToolOutputExpansion = function () {
		const currentIndex = TOOL_DISPLAY_MODES.indexOf(minimalToolDisplayState().displayMode);
		const nextMode = TOOL_DISPLAY_MODES[(currentIndex + 1) % TOOL_DISPLAY_MODES.length];
		setToolDisplayMode(nextMode);
		this.setToolsExpanded(nextMode === "full");
		this.showStatus(`Tool display mode: ${nextMode}`);
	};

	Object.defineProperty(prototype, "customPiToolModeCyclingPatched", {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});
}

function installToolDisplayModeRefresh(): void {
	const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
	if (prototype.customPiToolModeRefreshPatched) return;
	const setToolsExpanded = prototype.setToolsExpanded;
	prototype.setToolsExpanded = function (expanded) {
		const mode = minimalToolDisplayState().displayMode;
		const unchangedExpansion = this.toolOutputExpanded === expanded;
		const changedMode = this.customPiAppliedToolDisplayMode !== mode;
		setToolsExpanded.call(this, expanded);
		// Pi skips unchanged expansion. Command/Friendly/Compact are all
		// collapsed, but switching their presentation must rebuild cached shells.
		if (unchangedExpansion && changedMode) {
			for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
				for (const child of container?.children ?? []) {
					if (child instanceof ToolExecutionComponent) child.setExpanded(expanded);
				}
			}
		}
		this.customPiAppliedToolDisplayMode = mode;
	};
	Object.defineProperty(prototype, "customPiToolModeRefreshPatched", {
		value: true,
		configurable: false,
		writable: false,
	});
}

function installMinimalToolRendering(): void {
	const state = minimalToolDisplayState();
	state.renderMinimal = renderMinimalTool;
	const prototype = ToolExecutionComponent.prototype as unknown as MinimalToolPrototype;

	if (!prototype.customPiMinimalMousePatched) {
		const handleMouse = prototype.handleMouse;
		prototype.handleMouse = function (event) {
			if (this.expanded || minimalToolDisplayState().collapsedStyle !== "minimal") {
				return handleMouse.call(this, event);
			}
			// Dense rows do not share the native shell's child coordinates.
			// Only clicks in the actual rendered rows expand a completed tool;
			// leave wheel/drag/press events to the viewport's selection and scrolling.
			if (event.type !== "click" || event.button !== "left" || event.shift || event.ctrl || event.alt
				|| !this.result || this.isPartial || event.x < 0 || event.x >= event.width
				|| event.y < 0 || event.y >= (minimalToolDisplayState().renderMinimal?.(this, event.width)?.length ?? 0)) return undefined;
			this.setExpanded(true);
			this.ui.requestRender();
			return { handled: true };
		};
		Object.defineProperty(prototype, "customPiMinimalMousePatched", {
			value: true, configurable: false, writable: false,
		});
	}

	if (!prototype.customPiMinimalToolPatched) {
		const renderTool = prototype.render;
		prototype.render = function (width) {
			if (this.expanded || minimalToolDisplayState().collapsedStyle === "compact") {
				return renderTool.call(this, width);
			}
			return minimalToolDisplayState().renderMinimal?.(this, width) ?? renderTool.call(this, width);
		};
		Object.defineProperty(prototype, "customPiMinimalToolPatched", {
			value: true,
			configurable: false,
			enumerable: false,
			writable: false,
		});
	}

	if (!prototype.customPiMinimalToolV2Patched) {
		const renderCurrent = prototype.render;
		prototype.render = function (width) {
			if (!this.expanded && minimalToolDisplayState().collapsedStyle === "minimal") {
				return minimalToolDisplayState().renderMinimal?.(this, width) ?? renderCurrent.call(this, width);
			}
			return renderCurrent.call(this, width);
		};
		Object.defineProperty(prototype, "customPiMinimalToolV2Patched", {
			value: true,
			configurable: false,
			enumerable: false,
			writable: false,
		});
	}
}

class DurationSuffixComponent implements Component {
	constructor(
		private readonly component: Component,
		private readonly suffix: string,
	) {}

	render(width: number): string[] {
		const lines = [...this.component.render(width)];
		if (lines.some((line) => line.includes("Took "))) return lines;

		const lineIndex = lines.findIndex((line) => visibleWidth(line) > 0);
		if (lineIndex < 0) return lines;

		const suffix = truncateToWidth(this.suffix, width, "", false);
		const contentWidth = Math.max(0, width - visibleWidth(suffix));
		lines[lineIndex] = truncateToWidth(lines[lineIndex], contentWidth, "...", false) + suffix;
		return lines;
	}

	invalidate(): void {
		this.component.invalidate();
	}
}

function compactText(value: unknown, maxLength: number): string {
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, durationMs) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds - minutes * 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds.toFixed(1)}s`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes - hours * 60;
	return `${hours}h ${remainingMinutes}m ${remainingSeconds.toFixed(1)}s`;
}

function formatWholeSeconds(durationMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const totalMinutes = Math.floor(totalSeconds / 60);
	const remainingSeconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${remainingSeconds}s`;

	const hours = Math.floor(totalMinutes / 60);
	const remainingMinutes = totalMinutes % 60;
	return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
}

function formatLocalTimestamp(value: number | string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return undefined;
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} ${hours}:${minutes}`;
}

function formatUserTimestamp(value: number | string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return undefined;
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} ${hours}:${minutes}`;
}

function userMessageTimeState(): UserMessageTimeState {
	const globals = globalThis as typeof globalThis & {
		[USER_MESSAGE_TIME_STATE]?: UserMessageTimeState;
	};
	const state = globals[USER_MESSAGE_TIME_STATE] ??= {
		historicalImages: new Map<number, AssistantMessage>(),
		imagesExpanded: false,
		layoutRevision: 0,
		pendingTimestamps: [],
	};
	state.historicalImages ??= new Map<number, AssistantMessage>();
	state.imagesExpanded ??= false;
	return state;
}

const USER_IMAGE_MARKER = /\[Image attached:\s*([^\]\r\n]+)\]\s*/gi;

function bindUserMessageImages(instance: UserMessageInstance, message: AssistantMessage): void {
	const imageBlocks = message.content.filter((block) =>
		block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
	);
	if (imageBlocks.length === 0) return;

	const rawText = message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
	const skillBlock = parseSkillBlock(rawText);
	const displaySource = skillBlock ? skillBlock.userMessage ?? "" : rawText;
	const filenames = [...displaySource.matchAll(USER_IMAGE_MARKER)].map((match) => match[1].trim());
	const displayText = displaySource.replace(USER_IMAGE_MARKER, "").trim();
	if (instance.text !== displayText) {
		instance.text = displayText;
		instance.rebuild();
	}

	instance.customPiImages = imageBlocks.map((block, index) => {
		const dimensions = getImageDimensions(block.data!, block.mimeType!) ?? { widthPx: 800, heightPx: 600 };
		const imageTheme = {
			fallbackColor: (text: string) => userMessageTimeState().getTheme?.().fg("dim", text) ?? text,
		};
		const thumbnail = new Image(block.data!, block.mimeType!, imageTheme, {
			filename: filenames[index],
			maxHeightCells: 16,
			maxWidthCells: 60,
		}, dimensions);
		const expanded = new Image(block.data!, block.mimeType!, imageTheme, {
			filename: filenames[index],
			maxHeightCells: 40,
			maxWidthCells: 240,
		}, dimensions);
		return { dimensions, expanded, thumbnail };
	});
	instance.customPiImageRevision = userMessageTimeState().layoutRevision;
}

function isInvalidatable(value: unknown): value is { invalidate(): void } {
	return typeof value === "object" && value !== null
		&& "invalidate" in value && typeof value.invalidate === "function";
}

function isCurrentUserMessageImage(value: unknown): value is UserMessageImage {
	if (typeof value !== "object" || value === null) return false;
	const image = value as Partial<UserMessageImage>;
	return isInvalidatable(image.thumbnail) && isInvalidatable(image.expanded);
}

function setUserMessageImageExpansion(instance: UserMessageInstance, expanded: boolean): void {
	userMessageTimeState().imagesExpanded = expanded;
	const images = (instance.customPiImages ?? []) as unknown[];
	const currentImages = images.filter(isCurrentUserMessageImage);
	if (currentImages.length !== images.length) {
		for (const value of images) {
			if (typeof value !== "object" || value === null) continue;
			const image = value as { component?: unknown; expanded?: unknown; thumbnail?: unknown };
			for (const component of new Set([image.component, image.thumbnail, image.expanded])) {
				if (isInvalidatable(component)) component.invalidate();
			}
		}
		instance.customPiImages = undefined;
		instance.customPiImageRevision = undefined;
		instance.customPiImageExpanded = expanded;
		return;
	}
	if (instance.customPiImageExpanded === expanded) return;
	instance.customPiImageExpanded = expanded;
	for (const image of currentImages) {
		image.thumbnail.invalidate();
		image.expanded.invalidate();
	}
}

function styleFullWidthUserMessageLine(
	line: string,
	width: number,
	horizontalPadding: number,
	theme: FooterTheme | undefined,
): string {
	const leftPadding = " ".repeat(horizontalPadding);
	const rightPadding = " ".repeat(Math.max(0, width - horizontalPadding - visibleWidth(line)));
	if (!theme) return leftPadding + line + rightPadding;
	// Markdown may end with SGR 49/0. Reapply the band background to the
	// padding instead of allowing a nested reset to punch a hole in it.
	return theme.bg("userMessageBg", leftPadding)
		+ theme.bg("userMessageBg", line)
		+ theme.bg("userMessageBg", rightPadding);
}

function renderFullWidthUserMessage(instance: UserMessageInstance, width: number): string[] | undefined {
	if (width < 1) return undefined;
	const state = userMessageTimeState();
	if ((!instance.customPiImages || instance.customPiImageRevision !== state.layoutRevision)
		&& instance.customPiTimestamp !== undefined) {
		const timestamp = new Date(instance.customPiTimestamp).getTime();
		const historicalMessage = state.historicalImages.get(timestamp);
		if (historicalMessage) bindUserMessageImages(instance, historicalMessage);
	}
	const firstChild = instance.children[0];
	const messageContent = firstChild?.children?.[0] ?? firstChild;
	if (!messageContent) return undefined;

	const horizontalPadding = Math.min(instance.outputPad ?? 1, Math.floor((width - 1) / 2));
	const contentWidth = Math.max(1, width - horizontalPadding * 2);
	const textLines = messageContent.render(contentWidth);
	const hasText = textLines.some((line) => visibleWidth(line.replace(ANSI_SGR, "").trimEnd()) > 0);
	const images = instance.customPiImages ?? [];
	if (!hasText && images.length === 0) return undefined;

	const imageExpanded = state.imagesExpanded;
	const maxImageWidth = imageExpanded ? contentWidth : Math.max(1, Math.min(60, contentWidth));
	const bodyLines: string[] = [];
	for (const image of images) {
		const component = imageExpanded ? image.expanded : image.thumbnail;
		bodyLines.push(...component.render(maxImageWidth));
	}
	if (hasText) bodyLines.push(...textLines);

	const theme = state.getTheme?.();
	const styleLine = (line: string) => styleFullWidthUserMessageLine(line, width, horizontalPadding, theme);
	const lines = [styleLine(""), ...bodyLines.map(styleLine), styleLine("")];

	const timestamp = state.formatTimestamp?.(instance.customPiTimestamp);
	if (timestamp) {
		const displayTimestamp = truncateToWidth(timestamp, contentWidth, "...", false);
		const styledTimestamp = theme?.fg("dim", displayTimestamp) ?? displayTimestamp;
		lines.push(styledTimestamp);
	}
	if (lines.length > 0) {
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		lines.push(" ".repeat(width));
	}
	return lines;
}

function installUserMessageTimestamps(): void {
	const state = userMessageTimeState();
	state.layoutRevision = Number.isFinite(state.layoutRevision) ? state.layoutRevision + 1 : 1;
	state.bindImages = bindUserMessageImages;
	state.formatTimestamp = formatUserTimestamp;
	state.renderRightBubble = renderFullWidthUserMessage;
	state.setImageExpansion = setUserMessageImageExpansion;
	state.applyCompactLayout = (instance) => {
		const contentBox = instance.children[0];
		if (!contentBox) return;
		contentBox.paddingX = 0;
		contentBox.paddingY = 0;
		contentBox.invalidate();
		// Pi 1.x renders Markdown directly; older versions wrapped it in Box.
		if (!contentBox.children) return;
		while (contentBox.children.length > 1) {
			const extraChild = contentBox.children.at(-1);
			if (!extraChild) break;
			contentBox.removeChild(extraChild);
		}
	};

	const interactivePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
	if (!interactivePrototype.customPiUserMessageTimestampPatched) {
		const addMessageToChat = interactivePrototype.addMessageToChat;
		interactivePrototype.addMessageToChat = function (message, options) {
			if (message.role !== "user") {
				addMessageToChat.call(this, message, options);
				return;
			}
			const currentState = userMessageTimeState();
			currentState.pendingTimestamps.push(message.timestamp);
			try {
				addMessageToChat.call(this, message, options);
			} finally {
				currentState.pendingTimestamps.pop();
			}
		};
		Object.defineProperty(interactivePrototype, "customPiUserMessageTimestampPatched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	const bindCurrentUserImages = (
		instance: InteractiveModeInstance,
		beforeCount: number,
		message: Parameters<InteractiveModePrototype["addMessageToChat"]>[0],
	) => {
		if (message.role !== "user" || !Array.isArray(message.content)
			|| !message.content.some((block) => block.type === "image")) return;

		const userComponent = instance.chatContainer.children
			.slice(beforeCount)
			.filter((component): component is UserMessageComponent => component instanceof UserMessageComponent)
			.at(-1) as (UserMessageComponent & UserMessageInstance) | undefined;
		const currentState = userMessageTimeState();
		if (!userComponent || userComponent.customPiImageRevision === currentState.layoutRevision) return;
		currentState.bindImages?.(userComponent, message as AssistantMessage);
	};

	if (!interactivePrototype.customPiUserImagesPatched) {
		const addMessageWithTimestamp = interactivePrototype.addMessageToChat;
		interactivePrototype.addMessageToChat = function (message, options) {
			const beforeCount = this.chatContainer.children.length;
			addMessageWithTimestamp.call(this, message, options);
			bindCurrentUserImages(this, beforeCount, message);
		};
		Object.defineProperty(interactivePrototype, "customPiUserImagesPatched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	if (!interactivePrototype.customPiUserImagesV2Patched) {
		const addMessageWithCurrentImages = interactivePrototype.addMessageToChat;
		interactivePrototype.addMessageToChat = function (message, options) {
			const beforeCount = this.chatContainer.children.length;
			addMessageWithCurrentImages.call(this, message, options);
			bindCurrentUserImages(this, beforeCount, message);
		};
		Object.defineProperty(interactivePrototype, "customPiUserImagesV2Patched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	if (!interactivePrototype.customPiUserMessagesV3Patched) {
		const addMessageWithCurrentPresentation = interactivePrototype.addMessageToChat;
		interactivePrototype.addMessageToChat = function (message, options) {
			const beforeCount = this.chatContainer.children.length;
			addMessageWithCurrentPresentation.call(this, message, options);
			if (message.role !== "user") return;
			for (const component of this.chatContainer.children.slice(beforeCount)) {
				if (component instanceof SkillInvocationMessageComponent) component.setExpanded(false);
			}
			bindCurrentUserImages(this, beforeCount, message);
		};
		Object.defineProperty(interactivePrototype, "customPiUserMessagesV3Patched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	const userMessagePrototype = UserMessageComponent.prototype as unknown as UserMessagePrototype;
	if (!userMessagePrototype.customPiImageInvalidationPatched) {
		const invalidate = userMessagePrototype.invalidate;
		userMessagePrototype.invalidate = function () {
			invalidate.call(this);
			// Images are rendered outside native children. Propagate terminal cell
			// size and theme invalidation to both image-size caches explicitly.
			for (const image of this.customPiImages ?? []) {
				for (const component of [image.thumbnail, image.expanded]) {
					if (isInvalidatable(component)) component.invalidate();
				}
			}
		};
		Object.defineProperty(userMessagePrototype, "customPiImageInvalidationPatched", {
			value: true, configurable: false, writable: false,
		});
	}
	if (!userMessagePrototype.customPiImageExpansionPatched) {
		userMessagePrototype.setExpanded = function (expanded) {
			userMessageTimeState().setImageExpansion?.(this, expanded);
		};
		Object.defineProperty(userMessagePrototype, "customPiImageExpansionPatched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	if (!userMessagePrototype.customPiImageExpansionV2Patched) {
		userMessagePrototype.setExpanded = function (expanded) {
			userMessageTimeState().setImageExpansion?.(this, expanded);
		};
		Object.defineProperty(userMessagePrototype, "customPiImageExpansionV2Patched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	if (!userMessagePrototype.customPiTimestampPatched) {
		const rebuildTimestamp = userMessagePrototype.rebuild;
		userMessagePrototype.rebuild = function () {
			const currentState = userMessageTimeState();
			const pendingTimestamp = currentState.pendingTimestamps.at(-1);
			if (this.customPiTimestamp === undefined && pendingTimestamp !== undefined) {
				this.customPiTimestamp = pendingTimestamp;
			}
			rebuildTimestamp.call(this);
		};
		Object.defineProperty(userMessagePrototype, "customPiTimestampPatched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	if (!userMessagePrototype.customPiCompactLayoutPatched) {
		const rebuildLayout = userMessagePrototype.rebuild;
		userMessagePrototype.rebuild = function () {
			rebuildLayout.call(this);
			userMessageTimeState().applyCompactLayout?.(this);
			this.customPiCompactLayout = true;
		};
		const renderMessage = userMessagePrototype.render;
		userMessagePrototype.render = function (width) {
			if (!this.customPiCompactLayout) {
				userMessageTimeState().applyCompactLayout?.(this);
				this.customPiCompactLayout = true;
			}
			return renderMessage.call(this, width);
		};
		Object.defineProperty(userMessagePrototype, "customPiCompactLayoutPatched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	if (!userMessagePrototype.customPiCompactLayoutV3Patched) {
		const renderCurrentLayout = userMessagePrototype.render;
		userMessagePrototype.render = function (width) {
			const currentState = userMessageTimeState();
			if (this.customPiLayoutRevision !== currentState.layoutRevision) {
				currentState.applyCompactLayout?.(this);
				this.customPiLayoutRevision = currentState.layoutRevision;
			}
			return renderCurrentLayout.call(this, width);
		};
		Object.defineProperty(userMessagePrototype, "customPiCompactLayoutV3Patched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	if (!userMessagePrototype.customPiRightBubblePatched) {
		const renderFallback = userMessagePrototype.render;
		userMessagePrototype.render = function (width) {
			return userMessageTimeState().renderRightBubble?.(this, width) ?? renderFallback.call(this, width);
		};
		Object.defineProperty(userMessagePrototype, "customPiRightBubblePatched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}
}

function footerTimerState(): FooterTimerState {
	const globals = globalThis as typeof globalThis & {
		[FOOTER_TIMER_STATE]?: FooterTimerState;
		[LEGACY_FOOTER_TIMER_STATE]?: FooterTimerState;
	};
	return globals[FOOTER_TIMER_STATE] ??= globals[LEGACY_FOOTER_TIMER_STATE] ??= {};
}

function formatFooterTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatFooterCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const relativeToHome = relative(resolve(home), resolvedCwd);
	const isInsideHome = relativeToHome === ""
		|| (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeFooterText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ +/g, " ").trim();
}

function normalizeSessionName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const title = sanitizeFooterText(value).slice(0, MAX_SESSION_NAME_LENGTH);
	return title || undefined;
}

function restoreLegacyCtxTitle(ctx: ExtensionContext): string | undefined {
	let title: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== LEGACY_CTX_TITLE_ENTRY) continue;
		const value = (entry.data as LegacyCtxTitleEntry | undefined)?.title;
		title = value === null ? undefined : normalizeSessionName(value);
	}
	return title;
}

function styleSessionName(title: string): string {
	return riffHighlight(` ${title} `, "accent", true);
}

export function renderHighlightedSession(instance: FooterInstance, width: number, theme: FooterTheme): string {
	const manager = instance.session.sessionManager;
	let location = formatFooterCwd(manager.getCwd());
	const branch = instance.footerData.getGitBranch();
	if (branch) location += ` (${sanitizeFooterText(branch)})`;

	const sessionName = normalizeSessionName(manager.getSessionName());
	if (!sessionName) return truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "..."), false);

	const separator = " • ";
	const fullBadgeWidth = visibleWidth(sessionName) + 2;
	const availableForLocation = width - fullBadgeWidth - visibleWidth(separator);
	if (availableForLocation <= 0) {
		if (width <= 2) return truncateToWidth(sessionName, width, "", false);
		const visibleTitle = truncateToWidth(sessionName, width - 2, "...", false);
		return styleSessionName(visibleTitle);
	}

	const visibleLocation = truncateToWidth(location, availableForLocation, "...", false);
	return styleSessionName(sessionName) + separator + theme.fg("dim", visibleLocation);
}

function footerSecondaryStats(instance: FooterInstance): string {
	// Share Pi's accounting and invalidation rather than scanning entries again.
	const { usageTotals, latestCacheHitRate } = instance.getSessionStats();
	const { input: totalInput, output: totalOutput, cacheRead: totalCacheRead,
		cacheWrite: totalCacheWrite, cost: totalCost } = usageTotals;

	const parts: string[] = [];
	if (totalInput) parts.push(`↑${formatFooterTokens(totalInput)}`);
	if (totalOutput) parts.push(`↓${formatFooterTokens(totalOutput)}`);
	if (totalCacheRead) parts.push(`R${formatFooterTokens(totalCacheRead)}`);
	if (totalCacheWrite) parts.push(`W${formatFooterTokens(totalCacheWrite)}`);
	if ((totalCacheRead || totalCacheWrite) && latestCacheHitRate !== undefined) {
		parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}

	const model = instance.session.state.model;
	const usingSubscription = model
		? model.provider === "kimi-coding" || (instance.session.modelRuntime?.isUsingSubscription(model.provider) ?? false)
		: false;
	if (totalCost || usingSubscription) {
		parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}
	return parts.join(" ");
}

function renderFocusedFooterStats(instance: FooterInstance, width: number, theme: FooterTheme): string {
	const usage = instance.getSessionStats().contextUsage;
	const model = instance.session.state.model;
	const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
	const tokens = usage?.tokens;
	const percent = usage?.percent;

	const used = tokens === null || tokens === undefined ? "?" : formatFooterTokens(tokens);
	const context = contextWindow > 0 ? `${used}/${formatFooterTokens(contextWindow)}` : used;
	const percentText = percent === null || percent === undefined ? "" : `(${percent.toFixed(1)}%)`;
	const contextText = `${context}${percentText}`;

	const modelName = model?.id ?? "no-model";
	const modelIdentity = model ? `${model.provider}/${modelName}` : modelName;
	const thinkingLevel = model?.reasoning ? instance.session.state.thinkingLevel ?? "off" : undefined;
	let modelText = thinkingLevel ? `${modelIdentity}(${thinkingLevel})` : modelIdentity;
	const routed = instance.session.routedModel;
	if (routed) {
		const routedLevel = routed.thinkingLevel ? `(${routed.thinkingLevel})` : "";
		modelText += ` → ${routed.model.provider}/${routed.model.id}${routedLevel}`;
	}
	const primary = `${contextText} • ${modelText}`;
	const secondary = footerSecondaryStats(instance);

	const contextColor = percent !== null && percent !== undefined && percent > 90
		? "error"
		: percent !== null && percent !== undefined && percent > 70
			? "warning"
			: "dim";
	const styledPrimary = theme.fg(contextColor, contextText) + theme.fg("dim", ` • ${modelText}`);
	const primaryWidth = visibleWidth(primary);

	if (!secondary) return truncateToWidth(styledPrimary, width, "...", false);
	const secondaryWidth = visibleWidth(secondary);
	if (primaryWidth + 2 + secondaryWidth <= width) {
		return styledPrimary
			+ " ".repeat(width - primaryWidth - secondaryWidth)
			+ theme.fg("dim", secondary);
	}

	if (primaryWidth >= width) return theme.fg("dim", truncateToWidth(primary, width, "...", false));

	const availableForSecondary = Math.max(0, width - primaryWidth - 2);
	if (availableForSecondary === 0) return styledPrimary;
	const visibleSecondary = truncateToWidth(secondary, availableForSecondary, "", false);
	return styledPrimary + "  " + theme.fg("dim", visibleSecondary);
}

function installFooterStats(): void {
	const prototype = FooterComponent.prototype as unknown as FooterPrototype;
	footerTimerState().renderStats = renderFocusedFooterStats;
	if (!prototype.compactDynamicStatsPatched) {
		const renderFooter = prototype.render;
		prototype.render = function (width) {
			const lines = [...renderFooter.call(this, width)];
			const state = footerTimerState();
			const theme = state.getTheme?.();
			// If Pi changes its cached-statistics seam, preserve the native footer
			// rather than falling back to a divergent full-history aggregation.
			if (!theme || !state.renderStats || lines.length < 2 || typeof this.getSessionStats !== "function") return lines;
			lines[1] = state.renderStats(this, width, theme);
			return lines;
		};

		Object.defineProperty(prototype, "compactDynamicStatsPatched", {
			value: true,
			configurable: false,
			enumerable: false,
			writable: false,
		});
	}
}

function installFooterIdentity(): void {
	const prototype = FooterComponent.prototype as unknown as FooterPrototype;
	footerTimerState().renderIdentity = renderHighlightedSession;
	if (prototype.compactSessionIdentityPatched) return;

	const renderFooter = prototype.render;
	prototype.render = function (width) {
		const lines = [...renderFooter.call(this, width)];
		const state = footerTimerState();
		const theme = state.getTheme?.();
		if (!theme || !state.renderIdentity || lines.length === 0) return lines;
		lines[0] = state.renderIdentity(this, width, theme);
		return lines;
	};

	Object.defineProperty(prototype, "compactSessionIdentityPatched", {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});
}

function genericDuration(timing: GenericTiming | undefined): string | undefined {
	if (timing?.startedAt === undefined || timing.endedAt === undefined) return undefined;
	return `  Took ${formatDuration(timing.endedAt - timing.startedAt)}`;
}

function installGenericDuration(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as GenericFallbackPrototype;
	if (prototype.compactAllToolDurationPatched) return;

	const timings = new WeakMap<GenericToolExecutionInstance, GenericTiming>();
	const markExecutionStarted = prototype.markExecutionStarted;
	prototype.markExecutionStarted = function () {
		const timing = timings.get(this) ?? {};
		timing.startedAt ??= Date.now();
		timings.set(this, timing);
		markExecutionStarted.call(this);
	};

	const updateResult = prototype.updateResult;
	prototype.updateResult = function (result, isPartial = false) {
		if (!isPartial) {
			const timing = timings.get(this) ?? { startedAt: Date.now() };
			timing.endedAt ??= Date.now();
			timings.set(this, timing);
		}
		updateResult.call(this, result, isPartial);
	};

	const getCallRenderer = prototype.getCallRenderer;
	const retainedCallComponents = new WeakMap<GenericToolExecutionInstance, Component>();
	prototype.getCallRenderer = function () {
		const renderer = getCallRenderer.call(this);
		if (!renderer) return undefined;

		return ((args, theme, context) => {
			const retainedComponent = retainedCallComponents.get(this);
			const retainedContext = retainedComponent
				? { ...context, lastComponent: retainedComponent }
				: context;
			const component = renderer(args, theme, retainedContext);
			retainedCallComponents.set(this, component);

			const duration = context.expanded || minimalToolDisplayState().displayMode === "compact"
				? undefined : genericDuration(timings.get(this));
			return duration
				? new DurationSuffixComponent(component, theme.fg("muted", duration))
				: component;
		}) as CallRenderer;
	};

	const createCallFallback = prototype.createCallFallback;
	prototype.createCallFallback = function () {
		const component = createCallFallback.call(this);
		const duration = this.expanded || minimalToolDisplayState().displayMode === "compact"
			? undefined : genericDuration(timings.get(this));
		return duration ? new DurationSuffixComponent(component, duration) : component;
	};

	const formatToolExecution = prototype.formatToolExecution;
	prototype.formatToolExecution = function () {
		const text = formatToolExecution.call(this);
		const duration = this.expanded || minimalToolDisplayState().displayMode === "compact"
			? undefined : genericDuration(timings.get(this));
		if (!duration || text.includes("Took ")) return text;

		const [call, ...rest] = text.split("\n");
		return [`${call}${duration}`, ...rest].join("\n");
	};

	Object.defineProperty(prototype, "compactAllToolDurationPatched", {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});
}

export default function (pi: ExtensionAPI) {
	installGenericFallbackCompaction();
	installGenericDuration();
	installMinimalToolRendering();
	installToolDisplayModeCycling();
	installToolDisplayModeRefresh();
	installTimingEntrySpacing();
	installAssistantPresentation();
	installUserMessageTimestamps();
	installFooterStats();
	installFooterIdentity();
	footerTimerState().suffix = undefined;

	const setUserImageExpansion = (expanded: boolean, ctx: ExtensionContext) => {
		userMessageTimeState().imagesExpanded = expanded;
		ctx.ui.notify(expanded ? "User images expanded" : "User images shown as thumbnails", "info");
	};
	pi.registerCommand("image-size", {
		description: "Toggle user images between thumbnail and expanded display",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode && !["full", "expanded", "thumbnail", "collapsed"].includes(mode)) {
				ctx.ui.notify("Usage: /image-size [full|thumbnail]", "warning");
				return;
			}
			const expanded = mode === "full" || mode === "expanded"
				? true
				: mode === "thumbnail" || mode === "collapsed"
					? false
					: !userMessageTimeState().imagesExpanded;
			setUserImageExpansion(expanded, ctx);
		},
	});
	pi.registerShortcut("ctrl+shift+i", {
		description: "Toggle user image size",
		handler: async (ctx) => {
			setUserImageExpansion(!userMessageTimeState().imagesExpanded, ctx);
		},
	});

	let pendingAgentStartedAt: number | undefined;
	let agentStartedAt: number | undefined;
	let completedAgentRounds = 0;
	let cumulativeAgentDurationMs = 0;
	const cumulativeAgentDurationByTimestamp = new Map<number | string, number>();
	const agentRoundByTimestamp = new Map<number | string, number>();
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let workingTimerUI: ExtensionContext["ui"] | undefined;
	let sessionThemeGetter: (() => FooterTheme) | undefined;

	const restoreCumulativeAgentDuration = (ctx: ExtensionContext) => {
		const restored = cumulativeAgentDurations(ctx.sessionManager.getBranch());
		completedAgentRounds = restored.completedRounds;
		cumulativeAgentDurationMs = restored.totalDurationMs;
		cumulativeAgentDurationByTimestamp.clear();
		agentRoundByTimestamp.clear();
		for (const [timestamp, durationMs] of restored.byTimestamp) {
			cumulativeAgentDurationByTimestamp.set(timestamp, durationMs);
		}
		for (const [timestamp, round] of restored.roundByTimestamp) {
			agentRoundByTimestamp.set(timestamp, round);
		}
	};

	const renderWorkingStatus = (width: number): string[] => {
		if (agentStartedAt === undefined || !workingTimerUI || width <= 0) return [];
		const now = performance.now();
		const currentDurationMs = Math.max(0, now - agentStartedAt);
		const currentDuration = formatWholeSeconds(currentDurationMs);
		const cumulativeDuration = formatWholeSeconds(cumulativeAgentDurationMs + currentDurationMs);
		const theme = workingTimerUI.theme;
		const frame = SPINNER_GLYPHS[Math.floor(now / WORKING_SPINNER_INTERVAL_MS) % SPINNER_GLYPHS.length];
		const spinner = riffHighlight(frame, "warning", true, theme);
		const round = riffHighlight(`第 ${completedAgentRounds + 1} 轮`, "warning", true, theme);
		const separator = theme.fg("dim", " | ");
		const timing = riffHighlight(`${currentDuration} / ${cumulativeDuration}`, "warning", true, theme);
		const padding = width >= 3 ? 1 : 0;
		const margin = " ".repeat(padding);
		return [margin + truncateToWidth(`${spinner} ${round}${separator}${timing}`, width - padding * 2, "...", true) + margin];
	};

	const refreshWorkingTimer = () => {
		if (agentStartedAt === undefined || !workingTimerUI) return;
		assistantPresentationState().requestRender?.();
	};

	const startWorkingTimer = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || workingTimer !== undefined) return;
		workingTimerUI = ctx.ui;
		refreshWorkingTimer();
		workingTimer = setInterval(refreshWorkingTimer, WORKING_SPINNER_INTERVAL_MS);
	};

	const stopWorkingTimer = () => {
		if (workingTimer !== undefined) clearInterval(workingTimer);
		workingTimer = undefined;
		workingTimerUI = undefined;
		footerTimerState().suffix = undefined;
		assistantPresentationState().requestRender?.();
	};

	pi.registerEntryRenderer<AgentTimingEntry>(AGENT_TIMING_ENTRY, (entry, _options, theme) => {
		const durationMs = entry.data?.durationMs;
		if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return undefined;
		const totalDurationMs = typeof entry.data?.totalDurationMs === "number"
			&& Number.isFinite(entry.data.totalDurationMs)
			? entry.data.totalDurationMs
			: cumulativeAgentDurationByTimestamp.get(entry.timestamp);
		const total = totalDurationMs === undefined ? "" : ` / ${formatWholeSeconds(totalDurationMs)}`;
		const completedAt = formatLocalTimestamp(entry.data?.completedAt ?? entry.timestamp);
		const persistedRound = typeof entry.data?.round === "number" && Number.isInteger(entry.data.round)
			&& entry.data.round > 0
			? entry.data.round
			: undefined;
		const round = agentRoundByTimestamp.get(entry.timestamp) ?? persistedRound;
		const roundLabel = round === undefined
			? ""
			: riffHighlight(`第 ${round} 轮`, "accent", true, theme) + theme.fg("dim", " | ");
		const timing = riffHighlight(`${formatWholeSeconds(durationMs)}${total}`, "accent", true, theme);
		const timestamp = completedAt ? theme.fg("dim", ` | ${completedAt}`) : "";
		return new Text(roundLabel + timing + timestamp, 0, 0);
	});

	pi.on("input", (event) => {
		if (agentStartedAt === undefined) pendingAgentStartedAt = performance.now();
		return attachClipboardImages(event);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		agentStartedAt ??= pendingAgentStartedAt ?? performance.now();
		pendingAgentStartedAt = undefined;
		startWorkingTimer(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		agentStartedAt ??= performance.now();
		startWorkingTimer(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const startedAt = agentStartedAt;
		const durationMs = startedAt === undefined ? undefined : Math.max(0, performance.now() - startedAt);
		agentStartedAt = undefined;
		pendingAgentStartedAt = undefined;
		stopWorkingTimer();
		if (durationMs === undefined || ctx.mode !== "tui") return;

		cumulativeAgentDurationMs += durationMs;
		completedAgentRounds += 1;
		pi.appendEntry<AgentTimingEntry>(AGENT_TIMING_ENTRY, {
			round: completedAgentRounds,
			durationMs,
			completedAt: Date.now(),
			totalDurationMs: cumulativeAgentDurationMs,
		});
	});

	pi.on("session_shutdown", () => {
		// Prototype renderers can outlive the runner; release only our own callbacks.
		if (footerTimerState().getTheme === sessionThemeGetter) footerTimerState().getTheme = undefined;
		if (userMessageTimeState().getTheme === sessionThemeGetter) userMessageTimeState().getTheme = undefined;
		sessionThemeGetter = undefined;
		agentStartedAt = undefined;
		pendingAgentStartedAt = undefined;
		stopWorkingTimer();
		stopMinimalToolAnimation();
		stopAssistantDividerAnimation();
		assistantPresentationState().requestRender = undefined;
		assistantPresentationState().streamingMessageKey = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		assistantPresentationState().streamingMessageKey = undefined;
		restoreCumulativeAgentDuration(ctx);
		const toolState = minimalToolDisplayState();
		toolState.groupGeneration = 0;
		toolState.groupsAfterBody.clear();
		toolState.spacedGroups.clear();
		// Read the UI while ctx is active. Deferred renderers must never revisit ctx.
		const ui = ctx.ui;
		sessionThemeGetter = () => ui.theme;
		footerTimerState().getTheme = sessionThemeGetter;
		userMessageTimeState().getTheme = sessionThemeGetter;
		if (ctx.mode === "tui") {
			// Restore Pi's actual default editor, including future input fixes.
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setWorkingVisible(false);
			// Riff's loading/timing row is separate from Pi's hidden editor-border
			// indicator. It also supplies the public redraw handle for dividers.
			ctx.ui.setWidget("riff-render-hook", (tui) => {
				const requestRender = () => tui.requestRender();
				assistantPresentationState().requestRender = requestRender;
				syncAssistantDividerAnimation();
				return {
					render: renderWorkingStatus,
					invalidate() {},
					dispose() {
						if (assistantPresentationState().requestRender === requestRender) {
							stopWorkingTimer();
							assistantPresentationState().requestRender = undefined;
							stopAssistantDividerAnimation();
						}
					},
				};
			}, { placement: "aboveEditor" });
		}
		if (!pi.getSessionName()) {
			const legacyTitle = restoreLegacyCtxTitle(ctx);
			if (legacyTitle) pi.setSessionName(legacyTitle);
		}

		let thinkingChanged = false;
		const historicalImages = userMessageTimeState().historicalImages;
		historicalImages.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry.message as AssistantMessage;
			if (message.role === "user" && Array.isArray(message.content)
				&& message.content.some((block) => block.type === "image") && message.timestamp !== undefined) {
				const timestamp = new Date(message.timestamp).getTime();
				if (Number.isFinite(timestamp)) historicalImages.set(timestamp, message);
			}
			thinkingChanged = cleanThinkingBlocks(message) || thinkingChanged;
		}
		if (thinkingChanged && ctx.mode === "tui") {
			ctx.ui.setHiddenThinkingLabel();
		}

		ctx.ui.setToolsExpanded(toolState.displayMode === "full");
	});

	pi.on("tool_execution_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const shouldExpand = minimalToolDisplayState().displayMode === "full";
		if (ctx.ui.getToolsExpanded() !== shouldExpand) ctx.ui.setToolsExpanded(shouldExpand);
	});


	pi.on("message_start", (event) => {
		const message = event.message as AssistantMessage;
		if (message.role !== "assistant") return;
		assistantPresentationState().streamingMessageKey = assistantMessageKey(message);
	});

	pi.on("message_update", (event) => {
		const message = event.message as AssistantMessage;
		if (message.role === "assistant") {
			assistantPresentationState().streamingMessageKey = assistantMessageKey(message);
		}
		cleanThinkingBlocks(message);
	});

	pi.on("message_end", (event) => {
		const message = event.message as AssistantMessage;
		if (message.role === "assistant"
			&& assistantPresentationState().streamingMessageKey === assistantMessageKey(message)) {
			assistantPresentationState().streamingMessageKey = undefined;
		}
		if (!cleanThinkingBlocks(message)) return;
		return { message: event.message };
	});

	pi.registerCommand("tool-style", {
		description: "Set tool display mode: full, compact, command, or friendly",
		getArgumentCompletions: (prefix) => ["full", "compact", "command", "friendly"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (!mode) {
				ctx.ui.notify(`Tool display mode: ${minimalToolDisplayState().displayMode}`, "info");
				return;
			}
			if (mode !== "full" && mode !== "compact" && mode !== "command" && mode !== "friendly") {
				ctx.ui.notify("Usage: /tool-style full|compact|command|friendly", "error");
				return;
			}
			setToolDisplayMode(mode);
			ctx.ui.setToolsExpanded(mode === "full");
			ctx.ui.notify(`Tool display mode: ${mode}`, "info");
		},
	});

	pi.registerCommand("compact-tools", {
		description: "Leave Full mode and return to Friendly rendering",
		handler: async (_args, ctx) => {
			const state = minimalToolDisplayState();
			if (state.displayMode === "full") setToolDisplayMode("friendly");
			ctx.ui.setToolsExpanded(false);
			ctx.ui.notify(`Tool display mode: ${minimalToolDisplayState().displayMode}`, "info");
		},
	});
}
