import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createWriteToolDefinition,
	CustomEditor,
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
	getCellDimensions,
	getImageDimensions,
	Image,
	type ImageDimensions,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

// Global pi-riff behavior: compact tools, focused footer data, context title, and clipboard images.
const MAX_CALL_LENGTH = 120;
const MAX_ERROR_LENGTH = 180;
const MAX_CTX_TITLE_LENGTH = 120;
const MAX_TOOL_INTENT_LENGTH = 40;
const TOOL_INTENT_FIELD = "intent";
const CTX_TITLE_STATUS_KEY = "ctx-title";
const CTX_TITLE_ENTRY = "custom-pi-ctx-title";
const AGENT_TIMING_ENTRY = "compact-agent-timing";
const WORKING_TIMER_REFRESH_MS = 1000;
const WORKING_HIGHLIGHT = "\x1b[1;38;2;196;132;252m";
const TOOL_GREEN = "\x1b[38;2;86;196;112m";
const TOOL_GREEN_BOLD = "\x1b[1;38;2;86;196;112m";
const CTX_TITLE_BADGE = "\x1b[1;38;2;255;255;255;48;2;109;40;217m";
const ANSI_STYLE_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const SPINNER_GLYPHS = ["◐", "◓", "◑", "◒"] as const;
const TOOL_DISPLAY_MODES = ["full", "compact", "command", "friendly"] as const;
const WORKING_SPINNER_FRAMES = SPINNER_GLYPHS
	.map((frame) => `${WORKING_HIGHLIGHT}${frame}${ANSI_STYLE_RESET}`);
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

type RenderTheme = {
	bold(text: string): string;
	fg(color: "error" | "muted" | "toolOutput" | "toolTitle", text: string): string;
};

type TextResult = {
	content: Array<{ type: string; text?: string }>;
};

type CompactTimingState = {
	compactStartedAt?: number;
	compactEndedAt?: number;
	startedAt?: number;
	endedAt?: number;
};

type CompactRenderContext = {
	state: CompactTimingState;
	executionStarted: boolean;
	isPartial: boolean;
};

type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;

type GenericToolResult = {
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
	customPiToolIntentHiddenPatched?: boolean;
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
	args: Record<string, unknown>;
	callRendererComponent?: Component;
	customPiGroupSpacing?: boolean;
	customPiToolGroup?: number;
	cwd: string;
	formatToolExecution(): string;
	isPartial: boolean;
	resultRendererComponent?: Component;
	ui: { requestRender(): void };
};

type MinimalToolPrototype = {
	customPiMinimalToolPatched?: boolean;
	customPiMinimalToolV2Patched?: boolean;
	render(this: MinimalToolExecutionInstance, width: number): string[];
};

type ContainerPrototype = {
	addChild(component: Component): void;
	customPiTimingEntrySpacingPatched?: boolean;
	customPiToolGroupBindingPatched?: boolean;
	render(width: number): string[];
};

type AssistantPresentationState = {
	applyContentSpacing?: (instance: AssistantMessageInstance, message: AssistantMessage) => void;
	styleAssistantLines?: (lines: string[]) => string[];
	transformAssistantMessage?: (message: AssistantMessage) => AssistantMessage;
	transformMarkdownLines?: (lines: string[], theme: FooterTheme | undefined) => string[];
};

type AssistantMessageInstance = {
	contentContainer: {
		children: Component[];
	};
};

type AssistantMessagePrototype = {
	customPiContentSpacingV2Patched?: boolean;
	customPiThinkingSpacingPatched?: boolean;
	updateContent(this: AssistantMessageInstance, message: AssistantMessage): void;
};

type AgentTimingEntry = {
	durationMs: number;
	completedAt?: number;
};

type CtxTitleEntry = {
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
	children: Component[];
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
	rebuild(this: UserMessageInstance): void;
	render(this: UserMessageInstance, width: number): string[];
	setExpanded?(this: UserMessageInstance, expanded: boolean): void;
};

type InteractiveModeInstance = {
	chatContainer: {
		children: Component[];
	};
	setToolsExpanded(expanded: boolean): void;
	showStatus(message: string): void;
	toolOutputExpanded: boolean;
};

type InteractiveModePrototype = {
	customPiMarkdownThemePatched?: boolean;
	customPiToolGroupingPatched?: boolean;
	customPiToolModeCyclingPatched?: boolean;
	customPiUserImagesPatched?: boolean;
	customPiUserImagesV2Patched?: boolean;
	customPiUserMessagesV3Patched?: boolean;
	customPiUserMessageTimestampPatched?: boolean;
	getMarkdownThemeWithSettings(): Record<string, unknown>;
	toggleToolOutputExpansion(this: InteractiveModeInstance): void;
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
	modelRuntime?: {
		isUsingOAuth(providerId: string): boolean;
	};
	/** Compatibility with Pi versions before the ModelRuntime migration. */
	modelRegistry?: {
		isUsingOAuth(model: unknown): boolean;
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

type ObjectParameterSchema = {
	properties?: Record<string, unknown>;
	required?: string[];
	type?: unknown;
};

function addToolIntentParameter(tool: Pick<ToolDefinition, "parameters">): boolean {
	const schema = tool.parameters as unknown as ObjectParameterSchema;
	if (schema.type !== "object" || !schema.properties) return false;

	if (!(TOOL_INTENT_FIELD in schema.properties)) {
		schema.properties = {
			[TOOL_INTENT_FIELD]: Type.String({
				maxLength: MAX_TOOL_INTENT_LENGTH,
				description: "Human-friendly purpose of this tool call in the full task context. Explain why the step is useful; do not state status, results, Markdown, or raw command syntax.",
			}),
			...schema.properties,
		};
	}
	schema.required = [
		TOOL_INTENT_FIELD,
		...(schema.required ?? []).filter((key) => key !== TOOL_INTENT_FIELD),
	];
	return true;
}

function withToolIntentSchema<T extends ToolDefinition>(tool: T): T {
	addToolIntentParameter(tool);
	return tool;
}

function addToolIntentToAllTools(pi: ExtensionAPI): void {
	for (const tool of pi.getAllTools()) addToolIntentParameter(tool);
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

function attachClipboardImages(event: InputEvent): InputEventResult | undefined {
	if (event.source !== "interactive") return undefined;

	const paths = [...event.text.matchAll(CLIPBOARD_IMAGE_PATH)].map((match) => match[2]);
	if (paths.length === 0) return undefined;

	const attachedPaths = new Set<string>();
	const clipboardImages: NonNullable<InputEvent["images"]> = [];
	for (const imagePath of new Set(paths)) {
		try {
			const bytes = readFileSync(imagePath);
			if (bytes.length === 0 || bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) continue;
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

function argsWithoutToolIntent(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || !Object.prototype.hasOwnProperty.call(args, TOOL_INTENT_FIELD)) return args;
	const cleanArgs = { ...args };
	delete cleanArgs[TOOL_INTENT_FIELD];
	return cleanArgs;
}

function installToolIntentHiding(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as GenericFallbackPrototype;
	if (prototype.customPiToolIntentHiddenPatched) return;

	const getCallRenderer = prototype.getCallRenderer;
	prototype.getCallRenderer = function () {
		const renderer = getCallRenderer.call(this);
		if (!renderer) return undefined;
		return ((args, theme, context) => {
			const cleanArgs = argsWithoutToolIntent(args);
			return renderer(cleanArgs, theme, { ...context, args: cleanArgs });
		}) as CallRenderer;
	};

	const getResultRenderer = prototype.getResultRenderer;
	prototype.getResultRenderer = function () {
		const renderer = getResultRenderer.call(this);
		if (!renderer) return undefined;
		return ((result, options, theme, context) => {
			const cleanArgs = argsWithoutToolIntent(context.args);
			return renderer(result, options, theme, { ...context, args: cleanArgs });
		}) as ResultRenderer;
	};

	const formatToolExecution = prototype.formatToolExecution;
	prototype.formatToolExecution = function () {
		const originalArgs = this.args;
		this.args = argsWithoutToolIntent(originalArgs);
		try {
			return formatToolExecution.call(this);
		} finally {
			this.args = originalArgs;
		}
	};

	Object.defineProperty(prototype, "customPiToolIntentHiddenPatched", {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});
}

function installGenericFallbackCompaction(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as GenericFallbackPrototype;
	if (prototype.compactAllToolOutputPatched) return;

	const renderFallback = prototype.createResultFallback;
	prototype.createResultFallback = function () {
		if (this.expanded) return renderFallback.call(this);
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

			if (options.expanded) return component;
			if (this.result?.isError) return genericErrorComponent(this) ?? new Container();
			return new Container();
		}) as ResultRenderer;
	};

	const formatExpandedExecution = prototype.formatToolExecution;
	prototype.formatToolExecution = function () {
		if (this.expanded) return formatExpandedExecution.call(this);
		const error = this.result?.isError ? genericErrorText(this) : undefined;
		return error ? `${this.toolName}\n${error}` : this.toolName;
	};

	const updateDisplay = prototype.updateDisplay;
	prototype.updateDisplay = function () {
		updateDisplay.call(this);
		if (this.expanded) return;

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

function assistantContentRuns(message: AssistantMessage): Array<"body" | "thinking"> {
	const runs: Array<"body" | "thinking"> = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text?.trim()) {
			runs.push("body");
		} else if (block.type === "thinking" && block.thinking?.trim() && runs.at(-1) !== "thinking") {
			runs.push("thinking");
		}
	}
	return runs;
}

class SingleLineThinkingComponent implements Component {
	constructor(private readonly content: Component) {}

	render(width: number): string[] {
		const lines = this.content.render(Math.max(width, 4096));
		const theme = footerTimerState().getTheme?.();
		const ellipsis = theme?.italic(theme.fg("thinkingText", "...")) ?? "...";
		return lines.map((line) => {
			const withoutTerminalPadding = line.replace(/[\t ]+((?:\x1b\[[0-9;]*m)*)$/, "$1");
			return truncateToWidth(withoutTerminalPadding, width, ellipsis, true);
		});
	}

	invalidate(): void {
		this.content.invalidate?.();
	}
}

function applyAssistantContentSpacing(instance: AssistantMessageInstance, message: AssistantMessage): void {
	const runs = assistantContentRuns(message);
	const children = instance.contentContainer.children;
	if (runs[0] === "thinking" && children[0] instanceof Spacer) children.shift();

	let childIndex = 0;
	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		while (children[childIndex] instanceof Spacer) childIndex += 1;
		if (!children[childIndex]) break;
		if (runs[runIndex] === "thinking" && !(children[childIndex] instanceof SingleLineThinkingComponent)) {
			children[childIndex] = new SingleLineThinkingComponent(children[childIndex]);
		}
		childIndex += 1;
		if (runs[runIndex] === "body" && runs[runIndex + 1] === "thinking"
			&& !(children[childIndex] instanceof Spacer)) {
			children.splice(childIndex, 0, new Spacer(1));
		}
	}
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
			assistantPresentationState().applyContentSpacing?.(this, transformed);
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
}

function ensureToolIntentArgument(message: AssistantMessage): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const toolCall = block as typeof block & { arguments?: Record<string, unknown> };
		if (!toolCall.arguments || typeof toolCall.arguments[TOOL_INTENT_FIELD] === "string") continue;
		// Empty intent satisfies local validation while Friendly deliberately falls back to Command.
		toolCall.arguments[TOOL_INTENT_FIELD] = "";
	}
}

function assistantHasVisibleBody(message: Pick<AssistantMessage, "content">): boolean {
	return Array.isArray(message.content)
		&& message.content.some((block) => block.type === "text" && Boolean(block.text?.trim()));
}

function beginMinimalToolGroup(message?: Pick<AssistantMessage, "content">): void {
	const state = minimalToolDisplayState();
	state.groupGeneration += 1;
	if (message && assistantHasVisibleBody(message)) state.groupsAfterBody.add(state.groupGeneration);
}

function markMinimalToolGroupAfterBody(message: Pick<AssistantMessage, "content">): void {
	const state = minimalToolDisplayState();
	if (assistantHasVisibleBody(message)) state.groupsAfterBody.add(state.groupGeneration);
}

function minimalPath(value: unknown, cwd: string): string {
	if (typeof value !== "string" || !value) return "";
	return isAbsolute(value) ? formatFooterCwd(value) : value;
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
	label: string;
};

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

function minimalToolSummary(instance: MinimalToolExecutionInstance): MinimalToolSummary {
	const args = instance.args ?? {};
	const path = minimalPath(args.path ?? args.file_path, instance.cwd);
	switch (instance.toolName) {
		case "bash": {
			const detail = compactText(args.command, MAX_CALL_LENGTH);
			return { label: "$", detail, emphasizedDetailRange: firstShellCommandRange(detail) };
		}
		case "read": {
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const range = offset !== undefined || limit !== undefined
				? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
				: "";
			return { label: "read", detail: `${path}${range}` };
		}
		case "edit": {
			const count = Array.isArray(args.edits) ? args.edits.length : 0;
			return { label: "edit", detail: `${path}${count ? ` (${count} block${count === 1 ? "" : "s"})` : ""}` };
		}
		case "write": {
			const bytes = typeof args.content === "string" ? Buffer.byteLength(args.content, "utf8") : 0;
			return { label: "write", detail: `${path}${bytes ? ` (${bytes} bytes)` : ""}` };
		}
		case "grep":
			return { label: "grep", detail: `/${compactText(args.pattern, 60)}/ in ${path || "."}` };
		case "find":
			return { label: "find", detail: `${compactText(args.pattern, 60)} in ${path || "."}` };
		case "ls":
			return { label: "ls", detail: path || "." };
		default:
			return { label: instance.toolName, detail: compactText(minimalArgumentPreview(args), MAX_CALL_LENGTH) };
	}
}

function friendlyToolSummary(instance: MinimalToolExecutionInstance): MinimalToolSummary {
	const value = instance.args?.[TOOL_INTENT_FIELD];
	const intent = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	return intent
		? { label: compactText(intent, MAX_TOOL_INTENT_LENGTH), detail: "" }
		: minimalToolSummary(instance);
}

function styleMinimalToolDetail(summary: MinimalToolSummary, theme: FooterTheme | undefined): string {
	if (!summary.detail) return "";
	const range = summary.emphasizedDetailRange;
	if (!range) return theme?.fg("toolOutput", summary.detail) ?? summary.detail;

	const [start, end] = range;
	const before = summary.detail.slice(0, start);
	const command = summary.detail.slice(start, end);
	const after = summary.detail.slice(end);
	const styleNormal = (text: string) => theme?.fg("toolOutput", text) ?? text;
	const styledCommand = `${TOOL_GREEN_BOLD}${command}${ANSI_STYLE_RESET}`;
	return styleNormal(before) + styledCommand + styleNormal(after);
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
	const line = instance.callRendererComponent?.render(Math.max(1, width))
		.find((candidate) => visibleWidth(candidate) > 0);
	if (!line) return undefined;
	const plain = line.replace(ANSI_SGR, "");
	return plain.match(/\b(?:Took|Elapsed)\s+([0-9.]+(?:ms|s)|\d+m(?:\s+[0-9.]+s)?|\d+h[^ ]*)/)?.[1];
}

function renderMinimalTool(instance: MinimalToolExecutionInstance, width: number): string[] {
	const theme = footerTimerState().getTheme?.();
	const toolState = minimalToolDisplayState();
	instance.customPiToolGroup ??= toolState.groupGeneration;
	if (instance.customPiGroupSpacing === undefined) {
		const isFirstTool = !toolState.spacedGroups.has(instance.customPiToolGroup);
		instance.customPiGroupSpacing = isFirstTool && toolState.groupsAfterBody.has(instance.customPiToolGroup);
		toolState.spacedGroups.add(instance.customPiToolGroup);
	}

	trackMinimalToolAnimation(instance);
	const toolSummary = toolState.displayMode === "friendly"
		? friendlyToolSummary(instance)
		: minimalToolSummary(instance);
	const spinnerFrame = SPINNER_GLYPHS[Math.floor(performance.now() / 120) % SPINNER_GLYPHS.length];
	const runningMarker = instance.isPartial
		? `${TOOL_GREEN}${spinnerFrame}${ANSI_STYLE_RESET} `
		: "";
	const styledLabel = `${TOOL_GREEN_BOLD}${toolSummary.label}${ANSI_STYLE_RESET}`;
	const styledDetail = toolSummary.detail ? ` ${styleMinimalToolDetail(toolSummary, theme)}` : "";
	const duration = instance.isPartial ? undefined : renderedToolDuration(instance, width);
	const styledDuration = duration ? `  ${theme?.fg("muted", duration) ?? duration}` : "";
	const contentWidth = Math.max(1, width - visibleWidth(runningMarker));
	const summaryWidth = Math.max(1, contentWidth - visibleWidth(styledDuration));
	const summary = truncateToWidth(styledLabel + styledDetail, summaryWidth, "...", false);
	const lines = instance.customPiGroupSpacing
		? ["", runningMarker + summary + styledDuration]
		: [runningMarker + summary + styledDuration];

	if (instance.result?.isError) {
		const error = genericErrorText(instance);
		if (error) {
			const errorText = theme?.fg("error", error) ?? error;
			lines.push("  " + truncateToWidth(errorText, Math.max(1, width - 2), "...", false));
		}
	}
	return lines;
}

function installMinimalToolGrouping(): void {
	const containerPrototype = Container.prototype as unknown as ContainerPrototype;
	if (!containerPrototype.customPiToolGroupBindingPatched) {
		const addChild = containerPrototype.addChild;
		containerPrototype.addChild = function (component) {
			if (component instanceof ToolExecutionComponent) {
				const tool = component as unknown as MinimalToolExecutionInstance;
				tool.customPiToolGroup ??= minimalToolDisplayState().groupGeneration;
			}
			addChild.call(this, component);
		};
		Object.defineProperty(containerPrototype, "customPiToolGroupBindingPatched", {
			value: true,
			configurable: false,
			writable: false,
		});
	}

	const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
	if (prototype.customPiToolGroupingPatched) return;
	const addMessageToChat = prototype.addMessageToChat;
	prototype.addMessageToChat = function (message, options) {
		if (message.role === "assistant") beginMinimalToolGroup({ content: message.content ?? [] });
		addMessageToChat.call(this, message, options);
	};
	Object.defineProperty(prototype, "customPiToolGroupingPatched", {
		value: true,
		configurable: false,
		writable: false,
	});
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

function installMinimalToolRendering(): void {
	const state = minimalToolDisplayState();
	state.renderMinimal = renderMinimalTool;
	const prototype = ToolExecutionComponent.prototype as unknown as MinimalToolPrototype;

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

function userImageCellSize(
	dimensions: ImageDimensions,
	maxWidth: number,
	maxHeight: number,
	cell: ReturnType<typeof getCellDimensions>,
): { columns: number; rows: number } {
	const imageWidth = Math.max(1, dimensions.widthPx);
	const imageHeight = Math.max(1, dimensions.heightPx);
	const scale = Math.min(
		(maxWidth * cell.widthPx) / imageWidth,
		(maxHeight * cell.heightPx) / imageHeight,
	);
	return {
		columns: Math.max(1, Math.min(maxWidth, Math.ceil((imageWidth * scale) / cell.widthPx))),
		rows: Math.max(1, Math.min(maxHeight, Math.ceil((imageHeight * scale) / cell.heightPx))),
	};
}

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

function renderRightAlignedUserMessage(instance: UserMessageInstance, width: number): string[] | undefined {
	if (width < 4) return undefined;
	const state = userMessageTimeState();
	if ((!instance.customPiImages || instance.customPiImageRevision !== state.layoutRevision)
		&& instance.customPiTimestamp !== undefined) {
		const timestamp = new Date(instance.customPiTimestamp).getTime();
		const historicalMessage = state.historicalImages.get(timestamp);
		if (historicalMessage) bindUserMessageImages(instance, historicalMessage);
	}
	const messageContent = instance.children[0]?.children[0];
	if (!messageContent) return undefined;

	const timestamp = state.formatTimestamp?.(instance.customPiTimestamp);
	const maxBubbleWidth = Math.max(3, Math.min(width, Math.floor(width * 0.9)));
	const maxContentWidth = Math.max(1, maxBubbleWidth - 2);
	const probeLines = messageContent.render(maxContentWidth);
	const contentWidth = Math.max(0, ...probeLines.map((line) => visibleWidth(line.replace(ANSI_SGR, "").trimEnd())));
	const hasText = contentWidth > 0;
	const images = instance.customPiImages ?? [];
	if (!hasText && images.length === 0) return undefined;

	const cellDimensions = getCellDimensions();
	const imageExpanded = state.imagesExpanded;
	const maxImageWidth = imageExpanded
		? Math.max(1, width - 2)
		: Math.max(1, Math.min(60, maxBubbleWidth));
	const maxImageHeight = imageExpanded ? 40 : 16;
	const imageLayouts = images.map((image) => ({
		...image,
		size: userImageCellSize(image.dimensions, maxImageWidth, maxImageHeight, cellDimensions),
	}));
	const lines: string[] = [];
	for (const image of imageLayouts) {
		const component = imageExpanded ? image.expanded : image.thumbnail;
		for (const line of component.render(Math.min(width, maxImageWidth + 2))) {
			const renderedWidth = visibleWidth(line) || image.size.columns;
			lines.push(" ".repeat(Math.max(0, width - Math.min(width, renderedWidth))) + line);
		}
	}

	const timestampWidth = timestamp ? visibleWidth(timestamp) : 0;
	const bubbleWidth = hasText ? Math.min(maxBubbleWidth, Math.max(3, contentWidth + 2, timestampWidth)) : 0;
	const displayTimestamp = timestamp ? truncateToWidth(timestamp, hasText ? bubbleWidth : width, "...", false) : undefined;
	let timestampLeftPadding = "";
	if (hasText) {
		const leftPadding = " ".repeat(Math.max(0, width - bubbleWidth));
		const theme = state.getTheme?.();
		const bubble = new Box(1, 1, (text) => theme?.bg("userMessageBg", text) ?? text);
		bubble.addChild(messageContent);
		lines.push(...bubble.render(bubbleWidth).map((line) => leftPadding + line));
		timestampLeftPadding = leftPadding;
	} else {
		const imageWidth = Math.max(0, ...imageLayouts.map((image) => image.size.columns));
		timestampLeftPadding = " ".repeat(Math.max(0, width - Math.max(imageWidth, timestampWidth)));
	}
	if (displayTimestamp) {
		const styledTimestamp = state.getTheme?.().fg("dim", displayTimestamp) ?? displayTimestamp;
		lines.push(timestampLeftPadding + styledTimestamp);
	}
	if (lines.length > 0) {
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		lines.push(" ".repeat(width));
	}
	return lines;
}

function editorBorderIndicator(line: string): string | undefined {
	const plain = line.replace(ANSI_SGR, "");
	if (/^─+$/.test(plain)) return "";
	const match = plain.match(/^─+\s*([↑↓]\s+\d+\s+more)\s*─*$/);
	return match?.[1];
}

class CompactRailEditor extends CustomEditor {
	render(width: number): string[] {
		if (width < 4) return super.render(width);
		const rail = `${WORKING_HIGHLIGHT}│${ANSI_STYLE_RESET} `;
		const contentWidth = width - 2;
		const rendered = super.render(contentWidth);
		const lines: string[] = [];

		for (const line of rendered) {
			const indicator = editorBorderIndicator(line);
			if (indicator === "") continue;
			if (indicator) {
				const text = `${ANSI_DIM}${indicator}${ANSI_STYLE_RESET}`;
				lines.push(rail + text + " ".repeat(Math.max(0, contentWidth - visibleWidth(text))));
				continue;
			}
			lines.push(rail + line);
		}

		const contentLines = lines.length > 0 ? lines : [rail + " ".repeat(contentWidth)];
		const footerSpacing = " ".repeat(width);
		return [...contentLines, footerSpacing];
	}
}

function installUserMessageTimestamps(): void {
	const state = userMessageTimeState();
	state.layoutRevision = Number.isFinite(state.layoutRevision) ? state.layoutRevision + 1 : 1;
	state.bindImages = bindUserMessageImages;
	state.formatTimestamp = formatUserTimestamp;
	state.renderRightBubble = renderRightAlignedUserMessage;
	state.setImageExpansion = setUserMessageImageExpansion;
	state.applyCompactLayout = (instance) => {
		const contentBox = instance.children[0];
		if (!contentBox) return;
		contentBox.paddingX = Math.max(1, contentBox.paddingX);
		contentBox.paddingY = 1;
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

function normalizeCtxTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const title = sanitizeFooterText(value).slice(0, MAX_CTX_TITLE_LENGTH);
	return title || undefined;
}

function restoreCtxTitle(ctx: ExtensionContext): { found: boolean; title: string | undefined } {
	let found = false;
	let title: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CTX_TITLE_ENTRY) continue;
		found = true;
		const value = (entry.data as CtxTitleEntry | undefined)?.title;
		title = value === null ? undefined : normalizeCtxTitle(value);
	}
	return { found, title };
}

function styleCtxTitle(title: string): string {
	return `${CTX_TITLE_BADGE} ${title} ${ANSI_STYLE_RESET}`;
}

export function renderHighlightedSession(instance: FooterInstance, width: number, theme: FooterTheme): string {
	const manager = instance.session.sessionManager;
	let location = formatFooterCwd(manager.getCwd());
	const branch = instance.footerData.getGitBranch();
	if (branch) location += ` (${sanitizeFooterText(branch)})`;

	const ctxTitle = normalizeCtxTitle(
		instance.footerData.getExtensionStatuses().get(CTX_TITLE_STATUS_KEY),
	);
	if (!ctxTitle) return truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "..."), false);

	const separator = " • ";
	const fullBadgeWidth = visibleWidth(ctxTitle) + 2;
	const availableForLocation = width - fullBadgeWidth - visibleWidth(separator);
	if (availableForLocation <= 0) {
		if (width <= 2) return truncateToWidth(ctxTitle, width, "", false);
		const visibleTitle = truncateToWidth(ctxTitle, width - 2, "...", false);
		return styleCtxTitle(visibleTitle);
	}

	const visibleLocation = truncateToWidth(location, availableForLocation, "...", false);
	return styleCtxTitle(ctxTitle) + separator + theme.fg("dim", visibleLocation);
}

export function renderExtensionStatusLine(instance: FooterInstance, width: number): string | undefined {
	const statuses = Array.from(instance.footerData.getExtensionStatuses().entries())
		.filter(([key]) => key !== CTX_TITLE_STATUS_KEY)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
		.filter(Boolean);
	if (statuses.length === 0) return undefined;
	return truncateToWidth(statuses.join(" "), width, "...", false);
}

function footerSecondaryStats(instance: FooterInstance): string {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let latestCacheHitRate: number | undefined;

	for (const entry of instance.session.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (!usage) continue;

		totalInput += usage.input ?? 0;
		totalOutput += usage.output ?? 0;
		totalCacheRead += usage.cacheRead ?? 0;
		totalCacheWrite += usage.cacheWrite ?? 0;
		totalCost += usage.cost?.total ?? 0;

		const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (promptTokens > 0) latestCacheHitRate = ((usage.cacheRead ?? 0) / promptTokens) * 100;
	}

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
		? instance.session.modelRuntime?.isUsingOAuth(model.provider)
			?? instance.session.modelRegistry?.isUsingOAuth(model)
			?? false
		: false;
	if (totalCost || usingSubscription) {
		parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}
	return parts.join(" ");
}

function renderFocusedFooterStats(instance: FooterInstance, width: number, theme: FooterTheme): string {
	const usage = instance.session.getContextUsage();
	const model = instance.session.state.model;
	const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
	const tokens = usage?.tokens;
	const percent = usage?.percent;

	const used = tokens === null || tokens === undefined ? "?" : formatFooterTokens(tokens);
	const context = contextWindow > 0 ? `${used}/${formatFooterTokens(contextWindow)}` : used;
	const percentText = percent === null || percent === undefined ? "" : `(${percent.toFixed(1)}%)`;
	const contextText = `${context}${percentText}`;

	const modelName = model?.id ?? "no-model";
	const thinkingLevel = model?.reasoning ? instance.session.state.thinkingLevel ?? "off" : undefined;
	const modelText = thinkingLevel ? `${modelName}(${thinkingLevel})` : modelName;
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
			if (!theme || !state.renderStats || lines.length < 2) return lines;
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
		if (this.footerData.getExtensionStatuses().has(CTX_TITLE_STATUS_KEY)) {
			const otherStatusLine = renderExtensionStatusLine(this, width);
			if (otherStatusLine) {
				if (lines.length > 2) lines[2] = otherStatusLine;
				else lines.push(otherStatusLine);
			} else if (lines.length > 2) {
				lines.splice(2, 1);
			}
		}
		return lines;
	};

	Object.defineProperty(prototype, "compactSessionIdentityPatched", {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});
}

function installFooterCtxTitleStatusLine(): void {
	const prototype = FooterComponent.prototype as unknown as FooterPrototype;
	if (prototype.compactCtxTitleStatusLinePatched) return;

	const renderFooter = prototype.render;
	prototype.render = function (width) {
		const lines = [...renderFooter.call(this, width)];
		if (!this.footerData.getExtensionStatuses().has(CTX_TITLE_STATUS_KEY)) return lines;

		const otherStatusLine = renderExtensionStatusLine(this, width);
		if (otherStatusLine) {
			if (lines.length > 2) lines[2] = otherStatusLine;
			else lines.push(otherStatusLine);
		} else if (lines.length > 2) {
			lines.splice(2, 1);
		}
		return lines;
	};

	Object.defineProperty(prototype, "compactCtxTitleStatusLinePatched", {
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

			const duration = context.expanded ? undefined : genericDuration(timings.get(this));
			return duration
				? new DurationSuffixComponent(component, theme.fg("muted", duration))
				: component;
		}) as CallRenderer;
	};

	const createCallFallback = prototype.createCallFallback;
	prototype.createCallFallback = function () {
		const component = createCallFallback.call(this);
		const duration = this.expanded ? undefined : genericDuration(timings.get(this));
		return duration ? new DurationSuffixComponent(component, duration) : component;
	};

	const formatToolExecution = prototype.formatToolExecution;
	prototype.formatToolExecution = function () {
		const text = formatToolExecution.call(this);
		const duration = this.expanded ? undefined : genericDuration(timings.get(this));
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

function resultText(result: TextResult): string {
	return result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function compactResult(result: TextResult, isError: boolean, theme: RenderTheme) {
	if (!isError) return new Container();

	const firstLine = resultText(result)
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) ?? "Tool failed";

	return new Text(theme.fg("error", compactText(firstLine, MAX_ERROR_LENGTH)), 0, 0);
}

function updateTiming(context: CompactRenderContext): number | undefined {
	if (!context.executionStarted) return undefined;

	const state = context.state;
	state.compactStartedAt ??= Date.now();
	if (!context.isPartial) state.compactEndedAt ??= Date.now();
	if (state.compactEndedAt === undefined) return undefined;

	return Math.max(0, state.compactEndedAt - state.compactStartedAt);
}

function compactCall(label: string, detail: string, durationMs: number | undefined, theme: RenderTheme) {
	const suffix = detail ? ` ${compactText(detail, MAX_CALL_LENGTH)}` : "";
	const duration = durationMs === undefined ? "" : theme.fg("muted", `  Took ${(durationMs / 1000).toFixed(1)}s`);
	return new Text(
		theme.fg("toolTitle", theme.bold(label)) + theme.fg("toolOutput", suffix) + duration,
		0,
		0,
	);
}

function withCompactResult(tool: ToolDefinition): ToolDefinition {
	const renderExpanded = tool.renderResult;
	return {
		...tool,
		renderResult(result, options, theme, context) {
			if (options.expanded && renderExpanded) {
				return renderExpanded(result, options, theme, context);
			}
			return compactResult(result, context.isError, theme);
		},
	};
}

function registerCompactTools(pi: ExtensionAPI, cwd: string): void {
	const register = (tool: ToolDefinition) => pi.registerTool(withToolIntentSchema(tool));

	const bash = createBashToolDefinition(cwd);
	const renderExpandedBashCall = bash.renderCall;
	register(withCompactResult({
		...bash,
		renderCall(args, theme, context) {
			const durationMs = updateTiming(context);
			const state = context.state as CompactTimingState;
			state.startedAt ??= state.compactStartedAt;
			state.endedAt ??= state.compactEndedAt;
			if (context.expanded && renderExpandedBashCall) {
				return renderExpandedBashCall(args, theme, context);
			}
			return compactCall("$", args.command, durationMs, theme);
		},
	}));

	const edit = createEditToolDefinition(cwd);
	const renderExpandedEditCall = edit.renderCall;
	register(withCompactResult({
		...edit,
		renderCall(args, theme, context) {
			const durationMs = updateTiming(context);
			if (context.expanded && renderExpandedEditCall) {
				return renderExpandedEditCall(args, theme, context);
			}
			const count = Array.isArray(args.edits) ? args.edits.length : 0;
			const detail = `${args.path}${count > 0 ? ` (${count} block${count === 1 ? "" : "s"})` : ""}`;
			return compactCall("edit", detail, durationMs, theme);
		},
	}));

	const write = createWriteToolDefinition(cwd);
	const renderExpandedWriteCall = write.renderCall;
	register(withCompactResult({
		...write,
		renderCall(args, theme, context) {
			const durationMs = updateTiming(context);
			if (context.expanded && renderExpandedWriteCall) {
				return renderExpandedWriteCall(args, theme, context);
			}
			const bytes = Buffer.byteLength(args.content ?? "", "utf8");
			return compactCall("write", `${args.path} (${bytes} bytes)`, durationMs, theme);
		},
	}));

	const grep = createGrepToolDefinition(cwd);
	const renderExpandedGrepCall = grep.renderCall;
	register(withCompactResult({
		...grep,
		renderCall(args, theme, context) {
			const durationMs = updateTiming(context);
			if (context.expanded && renderExpandedGrepCall) {
				return renderExpandedGrepCall(args, theme, context);
			}
			return compactCall("grep", `/${args.pattern}/ in ${args.path || "."}`, durationMs, theme);
		},
	}));

	const find = createFindToolDefinition(cwd);
	const renderExpandedFindCall = find.renderCall;
	register(withCompactResult({
		...find,
		renderCall(args, theme, context) {
			const durationMs = updateTiming(context);
			if (context.expanded && renderExpandedFindCall) {
				return renderExpandedFindCall(args, theme, context);
			}
			return compactCall("find", `${args.pattern} in ${args.path || "."}`, durationMs, theme);
		},
	}));

	const ls = createLsToolDefinition(cwd);
	const renderExpandedLsCall = ls.renderCall;
	register(withCompactResult({
		...ls,
		renderCall(args, theme, context) {
			const durationMs = updateTiming(context);
			if (context.expanded && renderExpandedLsCall) {
				return renderExpandedLsCall(args, theme, context);
			}
			return compactCall("ls", args.path || ".", durationMs, theme);
		},
	}));
}

export default function (pi: ExtensionAPI) {
	installGenericFallbackCompaction();
	installGenericDuration();
	installToolIntentHiding();
	installMinimalToolRendering();
	installToolDisplayModeCycling();
	installMinimalToolGrouping();
	installTimingEntrySpacing();
	installAssistantPresentation();
	installUserMessageTimestamps();
	installFooterStats();
	installFooterIdentity();
	installFooterCtxTitleStatusLine();
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
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let workingTimerContext: ExtensionContext | undefined;

	const refreshWorkingTimer = () => {
		if (agentStartedAt === undefined || workingTimerContext?.mode !== "tui") return;
		const message = `Working... ${formatWholeSeconds(performance.now() - agentStartedAt)}`;
		workingTimerContext.ui.setWorkingMessage(
			`${WORKING_HIGHLIGHT}${message}${ANSI_STYLE_RESET}`,
		);
	};

	const startWorkingTimer = (ctx: typeof workingTimerContext) => {
		if (ctx?.mode !== "tui" || workingTimer !== undefined) return;
		workingTimerContext = ctx;
		refreshWorkingTimer();
		workingTimer = setInterval(refreshWorkingTimer, WORKING_TIMER_REFRESH_MS);
	};

	const stopWorkingTimer = () => {
		if (workingTimer !== undefined) clearInterval(workingTimer);
		workingTimer = undefined;
		workingTimerContext?.ui.setWorkingMessage();
		workingTimerContext = undefined;
		footerTimerState().suffix = undefined;
	};

	let ctxTitle: string | undefined;
	const setCtxTitle = (
		ctx: ExtensionContext,
		title: string | undefined,
		persist: boolean,
		syncSessionName = persist,
	) => {
		ctxTitle = title;
		ctx.ui.setStatus(CTX_TITLE_STATUS_KEY, title);
		// Explicit updates re-emit session_info so live session selectors refresh.
		if (syncSessionName && (persist || pi.getSessionName() !== title)) {
			pi.setSessionName(title ?? "");
		}
		if (persist) {
			pi.appendEntry<CtxTitleEntry>(CTX_TITLE_ENTRY, { title: title ?? null });
		}
	};

	pi.registerTool(withToolIntentSchema({
		name: "set_ctx_title",
		label: "Set Context Title",
		description: "Set and persist the stable parent context title shown in Pi's footer and mirror it to the current session display name. Follow the active project's instructions when choosing the title. Omit title to clear both values.",
		promptSnippet: "Set or clear the stable parent context title and current session display name",
		parameters: Type.Object({
			title: Type.Optional(Type.String({
				maxLength: MAX_CTX_TITLE_LENGTH,
				description: "Short complete context title chosen according to the active project's instructions; omit to clear",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const title = params.title === undefined ? undefined : normalizeCtxTitle(params.title);
			if (params.title !== undefined && !title) throw new Error("Context title must not be empty.");
			setCtxTitle(ctx, title, true);
			return {
				content: [{
					type: "text",
					text: title
						? `Context title and session name set to ${title}`
						: "Context title and session name cleared",
				}],
				details: { title: title ?? null, sessionName: title ?? null },
			};
		},
	}));

	pi.registerCommand("ctx-title", {
		description: "Show or clear the stable parent context title and session display name",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (!value) {
				ctx.ui.notify(`Context title: ${ctxTitle ?? "unset"}`, "info");
				return;
			}
			if (value === "clear") {
				setCtxTitle(ctx, undefined, true);
				return;
			}
			ctx.ui.notify("Usage: /ctx-title [clear]", "error");
		},
	});

	pi.registerEntryRenderer<AgentTimingEntry>(AGENT_TIMING_ENTRY, (entry, _options, theme) => {
		const durationMs = entry.data?.durationMs;
		if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return undefined;
		const completedAt = formatLocalTimestamp(entry.data?.completedAt ?? entry.timestamp);
		const timestamp = completedAt ? ` | ${completedAt}` : "";
		return new Text(theme.fg("dim", `Took ${formatWholeSeconds(durationMs)}${timestamp}`), 0, 0);
	});

	pi.on("input", (event) => {
		if (agentStartedAt === undefined) pendingAgentStartedAt = performance.now();
		return attachClipboardImages(event);
	});

	pi.on("before_agent_start", (event, ctx) => {
		addToolIntentToAllTools(pi);
		agentStartedAt ??= pendingAgentStartedAt ?? performance.now();
		pendingAgentStartedAt = undefined;
		startWorkingTimer(ctx);
		return {
			systemPrompt: `${event.systemPrompt}\n\nEvery tool call must provide ${TOOL_INTENT_FIELD}: a concise, human-friendly purpose in the user's language (maximum ${MAX_TOOL_INTENT_LENGTH} characters). Use the full task and conversation context to explain why the step is useful; do not merely translate the tool name or paraphrase the raw command. Do not state status, completion, results, Markdown, or raw command syntax.`,
		};
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

		pi.appendEntry<AgentTimingEntry>(AGENT_TIMING_ENTRY, { durationMs, completedAt: Date.now() });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		agentStartedAt = undefined;
		pendingAgentStartedAt = undefined;
		stopWorkingTimer();
		stopMinimalToolAnimation();
		setCtxTitle(ctx, undefined, false);
	});

	pi.on("session_start", (_event, ctx) => {
		const toolState = minimalToolDisplayState();
		toolState.groupGeneration = 0;
		toolState.groupsAfterBody.clear();
		toolState.spacedGroups.clear();
		const activeTheme = ctx.ui.theme;
		footerTimerState().getTheme = () => activeTheme;
		userMessageTimeState().getTheme = () => activeTheme;
		ctx.ui.setWorkingIndicator({ frames: WORKING_SPINNER_FRAMES, intervalMs: 80 });
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
			new CompactRailEditor(tui, editorTheme, keybindings),
		);
		const restoredCtxTitle = restoreCtxTitle(ctx);
		setCtxTitle(ctx, restoredCtxTitle.title, false, restoredCtxTitle.found);

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

		registerCompactTools(pi, ctx.cwd);
		addToolIntentToAllTools(pi);
		ctx.ui.setToolsExpanded(toolState.displayMode === "full");
	});

	pi.on("context", (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "assistant") return message;
			const content = message.content.map((block) => {
				if (block.type !== "toolCall" || !Object.prototype.hasOwnProperty.call(block.arguments, TOOL_INTENT_FIELD)) {
					return block;
				}
				changed = true;
				return { ...block, arguments: argsWithoutToolIntent(block.arguments) };
			});
			return content.some((block, index) => block !== message.content[index])
				? { ...message, content }
				: message;
		});
		return changed ? { messages } : undefined;
	});

	pi.on("tool_call", (event) => {
		delete event.input[TOOL_INTENT_FIELD];
	});

	pi.on("tool_execution_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const shouldExpand = minimalToolDisplayState().displayMode === "full";
		if (ctx.ui.getToolsExpanded() !== shouldExpand) ctx.ui.setToolsExpanded(shouldExpand);
	});


	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") beginMinimalToolGroup(event.message as AssistantMessage);
	});

	pi.on("message_update", (event) => {
		const message = event.message as AssistantMessage;
		ensureToolIntentArgument(message);
		cleanThinkingBlocks(message);
		if (message.role === "assistant") markMinimalToolGroupAfterBody(message);
	});

	pi.on("message_end", (event) => {
		const message = event.message as AssistantMessage;
		ensureToolIntentArgument(message);
		if (message.role === "assistant") markMinimalToolGroupAfterBody(message);
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
