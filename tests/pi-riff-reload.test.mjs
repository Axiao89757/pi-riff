import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(repositoryRoot, "extensions", "pi-riff.ts");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-riff-test-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});
const loaderRelativePath = join("dist", "core", "extensions", "loader.js");
const piExecutable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
let piRoot = dirname(dirname(piExecutable));
if (!existsSync(join(piRoot, loaderRelativePath))) {
	const npmEnvironment = { ...process.env };
	delete npmEnvironment.npm_config_prefix;
	delete npmEnvironment.NPM_CONFIG_PREFIX;
	const globalModules = execFileSync("npm", ["root", "-g"], {
		encoding: "utf8",
		env: npmEnvironment,
	}).trim();
	piRoot = join(globalModules, "@earendil-works", "pi-coding-agent");
}
assert.ok(existsSync(join(piRoot, loaderRelativePath)), `Cannot locate Pi package from ${piExecutable}`);
const loaderUrl = pathToFileURL(join(piRoot, loaderRelativePath));
const indexUrl = pathToFileURL(join(piRoot, "dist", "index.js"));
const themeUrl = pathToFileURL(join(piRoot, "dist", "modes", "interactive", "theme", "theme.js"));
const tuiUrl = pathToFileURL(join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"));
const { loadExtensions } = await import(loaderUrl.href);
const { AssistantMessageComponent, FooterComponent, InteractiveMode, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent, parseSkillBlock } = await import(indexUrl.href);
const { Container } = await import(tuiUrl.href);
const { initTheme, theme: activeTheme } = await import(themeUrl.href);
initTheme("dark");
const footerTimerState = globalThis[Symbol.for("pi.custom-pi.footer-timer")] ??= {};
footerTimerState.getTheme = () => activeTheme;

let legacyBindings = 0;
const footerPrototype = FooterComponent.prototype;
Object.defineProperty(footerPrototype, "compactContextStatusLinePatched", {
	value: true,
	configurable: false,
	writable: false,
});

const userMessagePrototype = UserMessageComponent.prototype;
userMessagePrototype.setExpanded = function (expanded) {
	if (this.customPiImageExpanded === expanded) return;
	this.customPiImageExpanded = expanded;
	for (const image of this.customPiImages ?? []) {
		image.thumbnail.invalidate();
		image.expanded.invalidate();
	}
};
Object.defineProperty(userMessagePrototype, "customPiImageExpansionPatched", {
	value: true,
	configurable: false,
	writable: false,
});

const interactivePrototype = InteractiveMode.prototype;
interactivePrototype.addMessageToChat = function (message) {
	if (message.role === "assistant") {
		this.chatContainer.children.push(new AssistantMessageComponent(message));
		return;
	}
	if (message.role !== "user") return;
	legacyBindings++;
	const text = Array.isArray(message.content)
		? message.content.filter((block) => block.type === "text").map((block) => block.text).join("")
		: "";
	const skillBlock = message.testSkillInvocation ? parseSkillBlock(text) : undefined;
	if (skillBlock) {
		const skill = new SkillInvocationMessageComponent(skillBlock);
		skill.setExpanded(true);
		this.chatContainer.children.push(skill);
	}
	const component = new UserMessageComponent(skillBlock?.userMessage ?? text);
	component.customPiImages = [{
		component: { invalidate() {} },
		dimensions: { widthPx: 1, heightPx: 1 },
	}];
	this.chatContainer.children.push(component);
};
Object.defineProperty(interactivePrototype, "customPiUserImagesPatched", {
	value: true,
	configurable: false,
	writable: false,
});

const retainedGroupedMessage = interactivePrototype.addMessageToChat;
interactivePrototype.addMessageToChat = function (message, options) {
	const state = globalThis[Symbol.for("pi.custom-pi.minimal-tool-state")];
	if (message.role === "assistant" && state) {
		state.groupGeneration += 1;
		if (message.content?.some((block) => block.type === "text" && block.text?.trim())) {
			state.groupsAfterBody.add(state.groupGeneration);
		}
	}
	retainedGroupedMessage.call(this, message, options);
};
Object.defineProperty(interactivePrototype, "customPiToolGroupingPatched", {
	value: true,
	configurable: false,
	writable: false,
});

const containerPrototype = Container.prototype;
const retainedToolBinding = containerPrototype.addChild;
containerPrototype.addChild = function (component) {
	if (component instanceof ToolExecutionComponent) {
		const state = globalThis[Symbol.for("pi.custom-pi.minimal-tool-state")];
		if (state) component.customPiToolGroup ??= state.groupGeneration;
	}
	retainedToolBinding.call(this, component);
};
Object.defineProperty(containerPrototype, "customPiToolGroupBindingPatched", {
	value: true,
	configurable: false,
	writable: false,
});

const loaded = await loadExtensions([extensionPath], repositoryRoot);
assert.deepEqual(loaded.errors, []);
const customPiExtension = loaded.extensions.find((extension) => extension.resolvedPath === extensionPath);
assert.ok(customPiExtension);
assert.equal(footerPrototype.compactSessionIdentityPatched, true);

const stripTerminalControls = (line) => line
	.replace(/\x1b\]133;[ABC]\x07/g, "")
	.replace(/\x1b\[[0-9;]*m/g, "");

test("Pi session name is the only title source", () => {
	const tool = customPiExtension.tools.get("set_ctx_title");
	assert.ok(tool);
	assert.equal(customPiExtension.commands.has("ctx-title"), false);
	assert.equal(customPiExtension.commands.has("workspace-context"), false);
	assert.equal(customPiExtension.tools.has("set_workspace_context"), false);
	assert.equal("title" in tool.definition.parameters.properties, true);
	assert.equal("intent" in tool.definition.parameters.properties, false);
	assert.equal((tool.definition.parameters.required ?? []).includes("intent"), false);
	assert.equal("status" in tool.definition.parameters.properties, false);
	assert.match(tool.definition.description, /Pi's native session display name/);
	assert.match(tool.definition.description, /active project's instructions/);

	const source = readFileSync(extensionPath, "utf8");
	assert.doesNotMatch(source, /registerCommand\("ctx-title"/);
	assert.doesNotMatch(source, /appendEntry<CtxTitleEntry>/);
	assert.doesNotMatch(source, /setStatus\(CTX_TITLE_STATUS_KEY/);
});

test("legacy context titles migrate once into Pi's native session name", () => {
	const script = `
		import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { pathToFileURL } from "node:url";
		const agentDir = mkdtempSync(join(tmpdir(), "pi-riff-name-"));
		mkdirSync(join(agentDir, "extensions"));
		symlinkSync(${JSON.stringify(extensionPath)}, join(agentDir, "extensions", "pi-riff.ts"));
		const { createAgentSession } = await import(pathToFileURL(join(${JSON.stringify(piRoot)}, "dist", "core", "sdk.js")).href);
		const { SessionManager } = await import(pathToFileURL(join(${JSON.stringify(piRoot)}, "dist", "core", "session-manager.js")).href);
		const manager = SessionManager.inMemory(${JSON.stringify(repositoryRoot)});
		manager.appendCustomEntry("custom-pi-ctx-title", { title: "Legacy title" });
		manager.appendCustomEntry("compact-agent-timing", { durationMs: 1_000, totalDurationMs: 1_000 });
		manager.appendCustomEntry("compact-agent-timing", { durationMs: 2_000, totalDurationMs: 3_000 });
		const { session, extensionsResult } = await createAgentSession({
			cwd: ${JSON.stringify(repositoryRoot)},
			agentDir,
			sessionManager: manager,
		});
		const ui = new Proxy({ theme: {}, getToolsExpanded: () => false }, {
			get: (target, property) => property in target ? target[property] : () => undefined,
		});
		try {
			await session.bindExtensions({ mode: "rpc", uiContext: ui });
			const migratedName = session.sessionName;
			const extension = extensionsResult.extensions.find((candidate) => candidate.tools.has("set_ctx_title"));
			const oldTimingEntry = manager.getEntries().filter(
				(entry) => entry.type === "custom" && entry.customType === "compact-agent-timing",
			).at(-1);
			const inferredTiming = extension.entryRenderers.get("compact-agent-timing")(
				oldTimingEntry, {}, { fg: (_color, text) => text },
			).render(100)[0].replace(/\\x1b\\[[0-9;]*m/g, "").trimEnd().split(" | ")[0];
			await extension.tools.get("set_ctx_title").definition.execute(
				"set-name", { title: "Native title" }, undefined, undefined, {},
			);
			console.log(JSON.stringify({
				migratedName,
				inferredTiming,
				updatedName: session.sessionName,
				legacyEntryCount: manager.getEntries().filter(
					(entry) => entry.type === "custom" && entry.customType === "custom-pi-ctx-title",
				).length,
			}));
		} finally {
			session.dispose();
			rmSync(agentDir, { recursive: true, force: true });
		}
	`;
	const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		input: script,
	}));
	assert.deepEqual(result, {
		migratedName: "Legacy title",
		inferredTiming: "第 2 轮 · 2s / 3s",
		updatedName: "Native title",
		legacyEntryCount: 1,
	});
});

test("active Agent timing uses yellow while completed turns stay purple", async () => {
	const messages = [];
	const ctx = {
		mode: "tui",
		ui: { setWorkingMessage: (message) => messages.push(message) },
	};
	const agentStart = customPiExtension.handlers.get("agent_start")?.[0];
	const sessionShutdown = customPiExtension.handlers.get("session_shutdown")?.[0];
	assert.ok(agentStart);
	assert.ok(sessionShutdown);
	await agentStart({}, ctx);
	await sessionShutdown({}, ctx);

	const activeMessage = messages.find((message) => typeof message === "string");
	assert.ok(activeMessage);
	assert.match(stripTerminalControls(activeMessage), /^第 1 轮 · \d+(?:\.\d)?s \/ \d+(?:\.\d)?s$/);
	assert.ok(activeMessage.includes("\x1b[1;38;2;251;191;36m"));
	assert.doesNotMatch(activeMessage, /\x1b\[[0-9;]*48;2/);
	const source = readFileSync(extensionPath, "utf8");
	assert.doesNotMatch(source, /ACTIVE_SPINNER_GLYPHS/);
	assert.match(source, /WORKING_SPINNER_FRAMES = SPINNER_GLYPHS/);
	assert.match(source, /ANSI_SUPERSCRIPT.*frame.*ANSI_BASELINE/);
	assert.match(source, /intervalMs: WORKING_SPINNER_INTERVAL_MS/);
	assert.equal(messages.at(-1), undefined);
});

test("agent timing entries show compact turn and cumulative duration", () => {
	const renderer = customPiExtension.entryRenderers.get("compact-agent-timing");
	assert.ok(renderer);
	const component = renderer({
		timestamp: new Date(2026, 6, 27, 17, 11).getTime(),
		data: {
			round: 4,
			durationMs: 12_900,
			totalDurationMs: 75_400,
			completedAt: new Date(2026, 6, 27, 17, 11).getTime(),
		},
	}, {}, activeTheme);
	assert.ok(component);
	const rawLine = component.render(100)[0];
	const line = stripTerminalControls(rawLine).trimEnd();
	assert.equal(line, "第 4 轮 · 12s / 1m 15s | 2026.7.27 17:11");
	assert.ok(rawLine.includes("\x1b[1;38;2;109;40;217m第 4 轮 · 12s\x1b[0m"));
	assert.ok(rawLine.includes(activeTheme.getFgAnsi("dim")));
});

test("Friendly labels have no model configuration or sidecar runtime", () => {
	assert.equal(customPiExtension.tools.has("set_riff_summary_model"), false);
	assert.equal(customPiExtension.commands.has("riff-model"), false);
	const source = readFileSync(extensionPath, "utf8");
	assert.doesNotMatch(source, /completeSimple/);
	assert.doesNotMatch(source, /pi-riff-tool-summary/);
	assert.doesNotMatch(source, /summaryModel/);
});

test("Command is the default and compact-tools returns to it", async () => {
	const state = globalThis[Symbol.for("pi.custom-pi.minimal-tool-state")];
	assert.equal(state.displayMode, "command");
	const command = customPiExtension.commands.get("compact-tools");
	assert.match(command.description, /Command rendering/);
	state.displayMode = "full";
	await command.handler("", { ui: { setToolsExpanded() {}, notify() {} } });
	assert.equal(state.displayMode, "command");
});

test("reload removes legacy display metadata without adding tool parameters", () => {
	const script = `
		import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { pathToFileURL } from "node:url";
		const extensionPath = ${JSON.stringify(extensionPath)};
		const piRoot = ${JSON.stringify(piRoot)};
		const repositoryRoot = ${JSON.stringify(repositoryRoot)};
		const agentDir = mkdtempSync(join(tmpdir(), "pi-riff-schema-"));
		mkdirSync(join(agentDir, "extensions"));
		symlinkSync(extensionPath, join(agentDir, "extensions", "pi-riff.ts"));
		const { createAgentSession } = await import(pathToFileURL(join(piRoot, "dist", "core", "sdk.js")).href);
		const { SessionManager } = await import(pathToFileURL(join(piRoot, "dist", "core", "session-manager.js")).href);
		const legacyTool = {
			name: "legacy_probe",
			label: "Legacy probe",
			description: "Tool carrying the pre-intent display field",
			parameters: {
				type: "object",
				properties: { _display_summary: { type: "string" }, query: { type: "string" } },
				required: ["query"],
			},
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const { session, extensionsResult } = await createAgentSession({
			cwd: repositoryRoot,
			agentDir,
			customTools: [legacyTool],
			sessionManager: SessionManager.inMemory(repositoryRoot),
		});
		const ui = new Proxy({ theme: {}, getToolsExpanded: () => false }, {
			get: (target, property) => property in target ? target[property] : () => undefined,
		});
		try {
			await session.bindExtensions({ mode: "rpc", uiContext: ui });
			const tool = session.getAllTools().find((candidate) => candidate.name === "legacy_probe");
			console.log(JSON.stringify({
				extensionErrors: extensionsResult.errors.length,
				hasLegacyProperty: "_display_summary" in tool.parameters.properties,
				hasLegacyRequired: tool.parameters.required.includes("_display_summary"),
				hasIntentProperty: "intent" in tool.parameters.properties,
				hasIntentRequired: tool.parameters.required.includes("intent"),
			}));
		} finally {
			session.dispose();
			rmSync(agentDir, { recursive: true, force: true });
		}
	`;
	const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module"], {
		encoding: "utf8",
		input: script,
	}));
	assert.deepEqual(result, {
		extensionErrors: 0,
		hasLegacyProperty: false,
		hasLegacyRequired: false,
		hasIntentProperty: false,
		hasIntentRequired: false,
	});
});

test("Friendly labels are local, deterministic, and all four modes are selectable", async () => {
	const toolCallHandlers = customPiExtension.handlers.get("tool_call") ?? [];
	assert.equal(toolCallHandlers.length, 1);
	const toolCall = {
		type: "tool_call",
		toolName: "probe",
		toolCallId: "probe-call",
		input: { query: "raw query", intent: "检查后台会话状态", _display_summary: "legacy summary" },
	};
	for (const handler of toolCallHandlers) await handler(toolCall, {});
	assert.deepEqual(toolCall.input, { query: "raw query" });

	const contextHandlers = customPiExtension.handlers.get("context") ?? [];
	assert.equal(contextHandlers.length, 1);
	const originalArguments = { query: "raw query", intent: "检查后台会话状态", _display_summary: "legacy summary" };
	const contextEvent = {
		type: "context",
		messages: [{ role: "assistant", content: [{ type: "toolCall", id: "probe-call", name: "probe", arguments: originalArguments }] }],
	};
	const contextResult = await contextHandlers[0](contextEvent, {});
	assert.deepEqual(contextResult.messages[0].content[0].arguments, { query: "raw query" });
	assert.equal(originalArguments.intent, "检查后台会话状态");
	assert.equal(originalArguments._display_summary, "legacy summary");

	const toolStyle = customPiExtension.commands.get("tool-style");
	assert.ok(toolStyle);
	assert.deepEqual(
		toolStyle.getArgumentCompletions("").map((entry) => entry.value),
		["full", "compact", "command", "friendly"],
	);
	const expandedStates = [];
	const notifications = [];
	const ctx = {
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setToolsExpanded: (expanded) => expandedStates.push(expanded),
		},
	};
	await toolStyle.handler("friendly", ctx);

	const component = new ToolExecutionComponent(
		"bash",
		"probe-call",
		{ command: "git status --short" },
		{},
		undefined,
		{ requestRender() {} },
		repositoryRoot,
	);
	component.updateResult({ content: [], details: undefined, isError: false });
	const friendlyLines = component.render(100).map(stripTerminalControls);
	assert.equal(friendlyLines.some((line) => line.includes("检查仓库状态")), true);
	assert.equal(friendlyLines.some((line) => line.includes("git status")), false);

	component.updateResult({
		content: [{ type: "text", text: "probe failed" }],
		details: undefined,
		isError: true,
	});
	const failedLines = component.render(100).map(stripTerminalControls);
	assert.equal(failedLines.some((line) => line.includes("检查仓库状态")), true);
	assert.equal(failedLines.some((line) => line.includes("probe failed")), true);

	await toolStyle.handler("command", ctx);
	const commandLines = component.render(100).map(stripTerminalControls);
	assert.equal(commandLines.some((line) => line.includes("git status --short")), true);
	assert.equal(commandLines.some((line) => line.includes("检查仓库状态")), false);

	await toolStyle.handler("full", ctx);
	component.setExpanded(true);
	const fullLines = component.render(100).map(stripTerminalControls);
	assert.equal(fullLines.some((line) => line.includes("intent")), false);
	assert.equal(fullLines.some((line) => line.includes("_display_summary")), false);
	assert.equal(expandedStates.at(-1), true);
	assert.deepEqual(notifications.map((entry) => entry.message), [
		"Tool display mode: friendly",
		"Tool display mode: command",
		"Tool display mode: full",
	]);
	await toolStyle.handler("friendly", ctx);
});

test("Thinking follows native visibility independently from tool display mode", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
	const message = {
		role: "assistant",
		timestamp: Date.now(),
		content: [{ type: "thinking", thinking: "Planning files\nInspecting dependencies\nRunning checks" }],
	};
	const component = new AssistantMessageComponent(message, true);
	let rendered = component.render(100).map(stripTerminalControls).join("\n");
	assert.match(rendered, /Thinking\.\.\./);
	assert.doesNotMatch(rendered, /Planning files|Inspecting dependencies|Running checks/);

	const completedMessage = { ...message, stopReason: "stop" };
	component.updateContent(completedMessage);
	rendered = component.render(100).map(stripTerminalControls).join("\n");
	assert.match(rendered, /Thinking · 3 steps · \d+\.\d+s/);
	assert.doesNotMatch(rendered, /Planning files|Running checks/);

	await toolStyle.handler("full", { ui: { notify() {}, setToolsExpanded() {} } });
	component.updateContent(completedMessage);
	rendered = component.render(100).map(stripTerminalControls).join("\n");
	assert.match(rendered, /Thinking · 3 steps/);
	assert.doesNotMatch(rendered, /Planning files|Running checks/);

	component.setHideThinkingBlock(false);
	rendered = component.render(100).map(stripTerminalControls).join("\n");
	assert.match(rendered, /Planning files/);
	assert.match(rendered, /Running checks/);
	assert.doesNotMatch(rendered, /Thinking · 3 steps/);

	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
	rendered = component.render(100).map(stripTerminalControls).join("\n");
	assert.match(rendered, /Planning files/);
	assert.doesNotMatch(rendered, /Thinking · 3 steps/);

	const mixed = new AssistantMessageComponent({
		role: "assistant",
		timestamp: Date.now() + 1,
		stopReason: "stop",
		content: [
			{ type: "thinking", thinking: "First thought" },
			{ type: "text", text: "Assistant body" },
			{ type: "thinking", thinking: "Second thought" },
		],
	});
	const mixedRawLines = mixed.render(100);
	const mixedLines = mixedRawLines.map(stripTerminalControls);
	const bodyIndex = mixedLines.findIndex((line) => line.includes("Assistant body"));
	assert.ok(bodyIndex > 1);
	assert.equal(mixedLines[bodyIndex - 2].trim(), "");
	assert.equal(mixedLines[bodyIndex - 1], `${" ".repeat(9)}${"━".repeat(81)}${" ".repeat(10)}`);
	assert.ok(mixedRawLines[bodyIndex - 1].includes("\x1b[38;2;109;40;217m"));
	assert.equal(mixedLines[bodyIndex].trimEnd(), " Assistant body");
	assert.equal(mixedRawLines[bodyIndex].includes(activeTheme.getBgAnsi("selectedBg")), false);
	assert.equal(mixedLines[bodyIndex + 1].trim(), "");

	const newerBody = new AssistantMessageComponent({
		role: "assistant",
		timestamp: Date.now() + 2,
		content: [{ type: "text", text: "Newer assistant body" }],
	});
	const newerRawLines = newerBody.render(100);
	const newerMarker = newerRawLines.find((line) => /^ {9}━{40}[◐◓◑◒]━{40} {10}$/.test(stripTerminalControls(line)));
	assert.ok(newerMarker?.includes("\x1b[38;2;109;40;217m"));
	assert.ok(newerMarker?.includes("\x1b[1;38;2;196;132;252m"));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.notEqual(stripTerminalControls(newerBody.render(100)[1]), stripTerminalControls(newerMarker));
	assert.match(stripTerminalControls(newerBody.render(8)[1]), /^━{3}[◐◓◑◒]━{3} $/);
	assert.match(stripTerminalControls(newerBody.render(40)[1]), /^ {3}━{16}[◐◓◑◒]━{16} {4}$/);
	const historicalLines = mixed.render(100).map(stripTerminalControls);
	assert.equal(historicalLines.includes(`${" ".repeat(9)}${"━".repeat(81)}${" ".repeat(10)}`), false);
	const historicalBodyIndex = historicalLines.findIndex((line) => line.includes("Assistant body"));
	assert.equal(historicalLines[historicalBodyIndex - 1], "");
	assert.match(historicalLines[historicalBodyIndex - 2], /First thought/);

	newerBody.updateContent({
		role: "assistant",
		timestamp: Date.now() + 2,
		stopReason: "stop",
		content: [{ type: "text", text: "Newer assistant body" }],
	});
	assert.equal(
		stripTerminalControls(newerBody.render(100)[1]),
		`${" ".repeat(9)}${"━".repeat(81)}${" ".repeat(10)}`,
	);
});

test("native hidden-thinking mode collapses every consecutive thinking run", () => {
	const message = {
		role: "assistant",
		timestamp: Date.now() + 2,
		stopReason: "aborted",
		content: [
			{ type: "thinking", thinking: "**Planning Excel sheet structure and columns**" },
			{ type: "thinking", thinking: "**Reviewing recent commits and routes**" },
			{ type: "text", text: "Visible assistant body" },
			{ type: "thinking", thinking: "**Confirming withdrawal and status project**" },
			{ type: "thinking", thinking: "**Summarizing feature priorities**" },
			{ type: "toolCall", id: "hidden-runs", name: "read", arguments: { path: "/tmp/file" } },
		],
	};
	const component = new AssistantMessageComponent(message, true);
	const rendered = component.render(100).map(stripTerminalControls).join("\n");
	assert.match(rendered, /Visible assistant body/);
	assert.doesNotMatch(rendered, /Planning Excel|Reviewing recent|Confirming withdrawal|Summarizing feature/);
	assert.equal((rendered.match(/Thinking · 2 steps/g) ?? []).length, 2);
});

test("streaming assistant dividers request redraws until the output settles", async (t) => {
	const state = globalThis[Symbol.for("pi.custom-pi.assistant-presentation-state")];
	let renderRequests = 0;
	state.requestRender = () => renderRequests++;
	t.after(() => {
		state.requestRender = undefined;
		if (state.animationTimer !== undefined) clearInterval(state.animationTimer);
		state.animationTimer = undefined;
	});

	const timestamp = Date.now() + 3;
	const partialMessage = {
		role: "assistant",
		timestamp,
		stopReason: "stop",
		content: [{ type: "text", text: "Streaming body" }],
	};
	for (const handler of customPiExtension.handlers.get("message_start") ?? []) {
		await handler({ type: "message_start", message: partialMessage }, {});
	}
	const component = new AssistantMessageComponent(partialMessage);
	await new Promise((resolve) => setTimeout(resolve, 220));
	assert.ok(renderRequests >= 2, `expected autonomous redraws, got ${renderRequests}`);

	for (const handler of customPiExtension.handlers.get("message_end") ?? []) {
		await handler({ type: "message_end", message: partialMessage }, {});
	}
	component.updateContent(partialMessage);
	const settledRenderRequests = renderRequests;
	await new Promise((resolve) => setTimeout(resolve, 140));
	assert.equal(renderRequests, settledRenderRequests);
});

test("live collapsed Thinking and its following tool render on adjacent lines", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
	const message = {
		role: "assistant",
		timestamp: Date.now() + 2,
		content: [{ type: "thinking", thinking: "Inspecting live state" }],
	};
	for (const handler of customPiExtension.handlers.get("message_start") ?? []) {
		await handler({ type: "message_start", message }, {});
	}

	const chat = new Container();
	const assistant = new AssistantMessageComponent(message, true);
	chat.addChild(assistant);
	const updated = {
		...message,
		content: [
			...message.content,
			{ type: "toolCall", id: "live-adjacent", name: "read", arguments: { path: "/tmp/project/src/live.ts" } },
		],
	};
	for (const handler of customPiExtension.handlers.get("message_update") ?? []) {
		await handler({ type: "message_update", message: updated }, {});
	}
	assistant.updateContent(updated);
	const tool = new ToolExecutionComponent(
		"read",
		"live-adjacent",
		{ path: "/tmp/project/src/live.ts" },
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);
	tool.updateResult({ content: [], details: undefined, isError: false });
	chat.addChild(tool);
	const completed = { ...updated, stopReason: "toolUse" };
	for (const handler of customPiExtension.handlers.get("message_end") ?? []) {
		await handler({ type: "message_end", message: completed }, {});
	}
	assistant.updateContent(completed);

	const lines = chat.render(100).map(stripTerminalControls);
	const thinkingIndex = lines.findIndex((line) => line.includes("Thinking · 1 step"));
	const toolIndex = lines.findIndex((line) => line.includes("read") && line.includes("live.ts"));
	assert.equal(toolIndex, thinkingIndex + 1, JSON.stringify(lines));

	const bodyMessage = {
		role: "assistant",
		timestamp: Date.now() + 3,
		content: [{ type: "thinking", thinking: "Preparing explanation" }],
	};
	for (const handler of customPiExtension.handlers.get("message_start") ?? []) {
		await handler({ type: "message_start", message: bodyMessage }, {});
	}
	const bodyChat = new Container();
	const bodyAssistant = new AssistantMessageComponent(bodyMessage, true);
	bodyChat.addChild(bodyAssistant);
	const bodyUpdated = {
		...bodyMessage,
		content: [
			...bodyMessage.content,
			{ type: "text", text: "Assistant explanation" },
			{ type: "toolCall", id: "body-separated", name: "read", arguments: { path: "/tmp/project/src/body.ts" } },
		],
	};
	for (const handler of customPiExtension.handlers.get("message_update") ?? []) {
		await handler({ type: "message_update", message: bodyUpdated }, {});
	}
	bodyAssistant.updateContent(bodyUpdated);
	assert.equal(stripTerminalControls(bodyAssistant.render(100).at(-1)).trim(), "");
	const bodyTool = new ToolExecutionComponent(
		"read",
		"body-separated",
		{ path: "/tmp/project/src/body.ts" },
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);
	bodyTool.updateResult({ content: [], details: undefined, isError: false });
	bodyChat.addChild(bodyTool);
	const bodyRawLines = bodyChat.render(100);
	const bodyLines = bodyRawLines.map(stripTerminalControls);
	const bodyIndex = bodyLines.findIndex((line) => line.includes("Assistant explanation"));
	const bodyToolIndex = bodyLines.findIndex((line) => line.includes("read") && line.includes("body.ts"));
	assert.equal(bodyLines[bodyIndex - 2].trim(), "");
	assert.match(bodyLines[bodyIndex - 1], /^ {9}━{40}[◐◓◑◒]━{40} {10}$/);
	assert.ok(bodyRawLines[bodyIndex - 1].includes("\x1b[38;2;109;40;217m"));
	assert.ok(bodyRawLines[bodyIndex - 1].includes("\x1b[1;38;2;196;132;252m"));
	assert.equal(bodyLines[bodyIndex].trimEnd(), " Assistant explanation");
	assert.equal(bodyRawLines[bodyIndex].includes(activeTheme.getBgAnsi("selectedBg")), false);
	assert.equal(bodyToolIndex, bodyIndex + 2, JSON.stringify(bodyLines));
	assert.equal(bodyLines[bodyIndex + 1].trim(), "");
});

test("Thinking and tools stay contiguous while every file tool keeps its full relative path", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
	const chat = { chatContainer: { children: [] } };
	interactivePrototype.addMessageToChat.call(chat, {
		role: "assistant",
		content: [{ type: "thinking", thinking: "Inspecting files" }],
	});

	const parent = new Container();
	const makeTool = (toolName, id, path) => {
		const component = new ToolExecutionComponent(
			toolName,
			id,
			{ path, ...(toolName === "edit" ? { edits: [] } : {}) },
			{},
			undefined,
			{ requestRender() {} },
			"/tmp/project",
		);
		component.updateResult({ content: [], details: undefined, isError: false });
		parent.addChild(component);
		return component;
	};
	const tools = [
		makeTool("read", "group-a", "/tmp/project/src/a.ts"),
		makeTool("read", "group-b", "/tmp/project/src/b.ts"),
		makeTool("edit", "group-c", "/tmp/project/src/c.ts"),
		makeTool("read", "group-d", "/tmp/project/src/d.ts"),
		makeTool("read", "group-e", "/tmp/project/src/e.ts"),
		makeTool("read", "group-f", "/tmp/project/src/f.ts"),
		makeTool("read", "group-g", "/tmp/project/src/g.ts"),
		makeTool("read", "group-test", "/tmp/project/test/g.ts"),
	];
	parent.render(100);
	const details = tools.map((tool) => tool.render(100).map(stripTerminalControls).find((line) => line.trim()) ?? "");
	assert.notEqual(tools[0].render(100)[0], "");
	assert.notEqual(tools[1].render(100)[0], "");
	const updatedAssistant = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Inspecting files" },
			{ type: "text", text: "Assistant explanation before tools" },
		],
	};
	for (const handler of customPiExtension.handlers.get("message_update") ?? []) {
		await handler({ type: "message_update", message: updatedAssistant }, {});
	}
	assert.notEqual(tools[0].render(100)[0], "");
	assert.notEqual(tools[1].render(100)[0], "");
	assert.match(details[0], /read src\/a\.ts/);
	assert.match(details[1], /read src\/b\.ts/);
	assert.match(details[2], /edit src\/c\.ts/);
	assert.match(details[5], /read src\/f\.ts/);
	assert.match(details[6], /read src\/g\.ts/);
	assert.match(details[7], /read test\/g\.ts/);

	interactivePrototype.addMessageToChat.call(chat, {
		role: "assistant",
		content: [{ type: "text", text: "Next assistant body" }],
	});
	const nextAssistant = chat.chatContainer.children.at(-1);
	assert.equal(stripTerminalControls(nextAssistant.render(100)[0]).trim(), "");
	const nextTool = new ToolExecutionComponent(
		"read",
		"next-group",
		{},
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);
	nextTool.updateResult({ content: [], details: undefined, isError: false });
	parent.addChild(nextTool);
	nextTool.updateArgs({ path: "/tmp/project/src/h.ts" });
	parent.render(100);
	const nextToolLines = nextTool.render(100);
	const nextDetail = nextToolLines.map(stripTerminalControls).find((line) => line.trim()) ?? "";
	assert.notEqual(nextToolLines[0], "");
	assert.match(nextDetail, /read src\/h\.ts/);

	const liveMessage = {
		role: "assistant",
		timestamp: Date.now(),
		content: [{ type: "thinking", thinking: "Live batch continuation" }],
	};
	for (const handler of customPiExtension.handlers.get("message_start") ?? []) {
		await handler({ type: "message_start", message: liveMessage }, {});
	}
	const liveAssistant = new AssistantMessageComponent(liveMessage);
	assert.match(stripTerminalControls(liveAssistant.render(100)[0]), /Live batch continuation/);
});

test("Command uses relative paths, preserves both ends, and right-aligns facts", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });

	const read = new ToolExecutionComponent(
		"read",
		"command-read",
		{ path: join(repositoryRoot, "docs", "agents", "issue-tracker.md") },
		{},
		undefined,
		{ requestRender() {} },
		repositoryRoot,
	);
	read.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree" }], details: undefined, isError: false });
	const readLine = read.render(80).map(stripTerminalControls).find((line) => line.includes("read"));
	assert.ok(readLine);
	assert.match(readLine, /read docs\/agents\/issue-tracker\.md/);
	const styledReadLine = read.render(80).find((line) => line.includes("issue-tracker.md"));
	assert.match(styledReadLine, /\x1b\[1;38;2;86;196;112missue-tracker\.md\x1b\[0m/);
	assert.doesNotMatch(readLine, new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(readLine, /3 lines\s+\d+(?:\.\d+)?(?:ms|s)$/);
	assert.equal(readLine.length, 80);
	assert.ok(read.render(12).every((line) => stripTerminalControls(line).length <= 12));

	const command = new ToolExecutionComponent(
		"bash",
		"command-bash",
		{ command: `git -C ${repositoryRoot} status --short -- ${"deep/".repeat(18)}important-target.md` },
		{},
		undefined,
		{ requestRender() {} },
		repositoryRoot,
	);
	command.updateResult({ content: [], details: undefined, isError: false });
	const commandLine = command.render(72).map(stripTerminalControls).find((line) => line.includes("git"));
	assert.ok(commandLine);
	assert.match(commandLine, /^\$ git -C \. status/);
	assert.match(commandLine, /\.\.\..*important-target\.md\s+\d+(?:\.\d+)?(?:ms|s)$/);
	assert.ok(commandLine.length <= 72);
	const styledCommandLine = command.render(100).find((line) => line.includes("status"));
	assert.match(styledCommandLine, /\x1b\[1;38;2;86;196;112mgit\x1b\[0m/);
	assert.match(styledCommandLine, /\x1b\[1;38;2;86;196;112mstatus\x1b\[0m/);

	const rg = new ToolExecutionComponent(
		"bash",
		"command-rg",
		{ command: 'rg -n -i "GLB|STEP|cad_part" src/' },
		{},
		undefined,
		{ requestRender() {} },
		repositoryRoot,
	);
	rg.updateResult({ content: [], details: undefined, isError: false });
	const styledRgLine = rg.render(100).find((line) => line.includes("GLB"));
	assert.match(styledRgLine, /\x1b\[1;38;2;86;196;112mrg\x1b\[0m/);
	assert.match(styledRgLine, /\x1b\[1;38;2;86;196;112m"GLB\|STEP\|cad_part"\x1b\[0m/);
	assert.doesNotMatch(styledRgLine, /\x1b\[1;38;2;86;196;112msrc\x1b\[0m/);

	await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
});

test("Command highlights one semantic token for frequent shell tools", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
	const cases = [
		{ command: "npm run test", semantic: "test" },
		{ command: "npm --prefix . pack", semantic: "pack" },
		{ command: "node --experimental-strip-types --check src/index.ts", semantic: "--check" },
		{ command: "node scripts/check.mjs", semantic: "scripts/check.mjs" },
		{ command: "playwright-cli -s=pi snapshot", semantic: "snapshot" },
		{ command: "make service-status", semantic: "service-status" },
		{ command: "find . -name '*.ts'", semantic: "'*.ts'" },
		{ command: "jq -r '.name' package.json", semantic: "'.name'" },
		{ command: "curl -fsSL https://example.com/archive", semantic: "https://example.com/archive" },
		{ command: "pi --no-extensions --list-models", semantic: "--list-models" },
		{ command: "gh repo view", semantic: "repo" },
		{ command: "docker compose ps", semantic: "compose" },
		{ command: "uv run pytest", semantic: "run" },
		{ command: "python3 -m pytest", semantic: "pytest" },
		{ command: "shasum -a 256 package.json", semantic: "package.json" },
		{ command: "cp source.ts dist/target.ts", semantic: "dist/target.ts" },
		{ command: "lock=.scratch/lock lock -n 'merge'", semantic: "lock" },
		{ command: "test ! -d .scratch/lock && echo released", semantic: "test" },
	];
	for (const [index, item] of cases.entries()) {
		const component = new ToolExecutionComponent("bash", `semantic-${index}`, { command: item.command }, {}, undefined, { requestRender() {} }, repositoryRoot);
		component.updateResult({ content: [], details: undefined, isError: false });
		const line = component.render(120).find((candidate) => candidate.includes(item.semantic));
		const escaped = item.semantic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		assert.match(line, new RegExp(`\\x1b\\[1;38;2;86;196;112m${escaped}\\x1b\\[0m`), item.command);
	}
	await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
});

test("Command drops passive sleep prefixes before the actionable command", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
	const originalCommand = "sleep 240; tmux capture-pane -p -t fto-runtime:worker; redis-cli ZCARD queue";
	const component = new ToolExecutionComponent("bash", "sleep-prefix", { command: originalCommand }, {}, undefined, { requestRender() {} }, repositoryRoot);
	component.updateResult({ content: [], details: undefined, isError: false });
	const line = component.render(100).find((candidate) => candidate.includes("tmux"));
	assert.match(stripTerminalControls(line), /^\$ tmux capture-pane/);
	assert.doesNotMatch(stripTerminalControls(line), /sleep 240/);
	assert.match(line, /\x1b\[1;38;2;86;196;112mtmux\x1b\[0m/);
	assert.match(line, /\x1b\[1;38;2;86;196;112mcapture-pane\x1b\[0m/);
	assert.equal(component.args.command, originalCommand);
	await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
});

test("Command highlights each actionable segment in chained shell commands", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
	const originalCommand = "cd code/fto_design_web && node --test dossier.test.mjs && npm run build:type";
	const component = new ToolExecutionComponent("bash", "chained-command", { command: originalCommand }, {}, undefined, { requestRender() {} }, repositoryRoot);
	component.updateResult({ content: [], details: undefined, isError: false });
	const line = component.render(160).find((candidate) => candidate.includes("dossier"));
	assert.match(line, /\x1b\[1;38;2;86;196;112mcd\x1b\[0m/);
	assert.match(line, /\x1b\[1;38;2;86;196;112mnode\x1b\[0m/);
	assert.match(line, /\x1b\[1;38;2;86;196;112m--test\x1b\[0m/);
	assert.match(line, /\x1b\[1;38;2;86;196;112mnpm\x1b\[0m/);
	assert.match(line, /\x1b\[1;38;2;86;196;112mbuild:type\x1b\[0m/);
	assert.equal(component.args.command, originalCommand);
	await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
});

test("Command shows live write and edit progress while arguments stream", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });

	const write = new ToolExecutionComponent("write", "streaming-write", { path: "/tmp/project/PRD.md", content: "abc" }, {}, undefined, { requestRender() {} }, "/tmp/project");
	const edit = new ToolExecutionComponent("edit", "streaming-edit", { path: "/tmp/project/app.ts", edits: [{ oldText: "a", newText: "b" }] }, {}, undefined, { requestRender() {} }, "/tmp/project");
	try {
		const initialWrite = write.render(80).map(stripTerminalControls).find((line) => line.includes("write"));
		assert.match(initialWrite, /3 bytes/);
		write.updateArgs({ path: "/tmp/project/PRD.md", content: "abcdefgh" });
		const updatedWrite = write.render(80).map(stripTerminalControls).find((line) => line.includes("write"));
		assert.match(updatedWrite, /8 bytes/);
		assert.notEqual(initialWrite, updatedWrite);

		assert.match(edit.render(80).map(stripTerminalControls).find((line) => line.includes("edit")), /1 edit/);
		edit.updateArgs({ path: "/tmp/project/app.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] });
		assert.match(edit.render(80).map(stripTerminalControls).find((line) => line.includes("edit")), /2 edits/);
	} finally {
		write.updateResult({ content: [], details: undefined, isError: false });
		edit.updateResult({ content: [], details: undefined, isError: false });
		write.render(80);
		edit.render(80);
		await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
	}
});

test("Command exposes deterministic edit, write, and search facts", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
	const cases = [
		{ tool: "edit", args: { path: "/tmp/project/a.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, result: "ok", expected: /2 edits/ },
		{ tool: "write", args: { path: "/tmp/project/a.txt", content: "hello" }, result: "ok", expected: /5 bytes/ },
		{ tool: "grep", args: { pattern: "needle", path: "/tmp/project" }, result: "a.ts:1: needle\nb.ts:2: needle", expected: /2 matches/ },
		{ tool: "find", args: { pattern: "*.ts", path: "/tmp/project" }, result: "a.ts\nb.ts", expected: /2 files/ },
		{ tool: "ls", args: { path: "/tmp/project" }, result: "a.ts\nb.ts\nsrc/", expected: /3 entries/ },
	];
	for (const [index, item] of cases.entries()) {
		const component = new ToolExecutionComponent(item.tool, `fact-${index}`, item.args, {}, undefined, { requestRender() {} }, "/tmp/project");
		component.updateResult({ content: [{ type: "text", text: item.result }], details: undefined, isError: false });
		const line = component.render(90).map(stripTerminalControls).find((candidate) => candidate.trim());
		assert.match(line, item.expected);
	}
	await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
});

test("Friendly labels describe file operations without model output", () => {
	const cases = [
		{ tool: "read", args: { path: "/tmp/project/package.json" }, expected: "读取 package.json" },
		{ tool: "edit", args: { path: "/tmp/project/README.md", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, expected: "编辑 README.md（2 处）" },
		{ tool: "write", args: { path: "/tmp/project/config.json", content: "{}" }, expected: "写入 config.json" },
	];
	for (const [index, item] of cases.entries()) {
		const component = new ToolExecutionComponent(item.tool, `local-${index}`, item.args, {}, undefined, { requestRender() {} }, "/tmp/project");
		component.updateResult({ content: [], details: undefined, isError: false });
		assert.equal(component.render(100).map(stripTerminalControls).some((line) => line.includes(item.expected)), true);
	}
});

test("main-agent tool messages are not given Friendly metadata", async () => {
	assert.equal((customPiExtension.handlers.get("before_agent_start") ?? []).length, 1);
	const message = {
		role: "assistant",
		content: [{ type: "toolCall", id: "missing-summary", name: "bash", arguments: { command: "git status" } }],
	};
	for (const handler of customPiExtension.handlers.get("message_end") ?? []) {
		await handler({ type: "message_end", message }, { model: undefined });
	}
	assert.deepEqual(message.content[0].arguments, { command: "git status" });

	const component = new ToolExecutionComponent(
		"bash",
		"missing-summary",
		message.content[0].arguments,
		{},
		undefined,
		{ requestRender() {} },
		repositoryRoot,
	);
	component.updateResult({ content: [], details: undefined, isError: false });
	const lines = component.render(100).map(stripTerminalControls);
	assert.equal(lines.some((line) => line.includes("检查仓库状态")), true);
	assert.equal(lines.some((line) => line.includes("git status")), false);
});

test("Ctrl+O cycles Full, Compact, Command, and Friendly modes", () => {
	const expandedStates = [];
	const statuses = [];
	const instance = {
		toolOutputExpanded: false,
		setToolsExpanded(expanded) {
			this.toolOutputExpanded = expanded;
			expandedStates.push(expanded);
		},
		showStatus(message) {
			statuses.push(message);
		},
	};

	for (let index = 0; index < 4; index++) {
		interactivePrototype.toggleToolOutputExpansion.call(instance);
	}

	assert.deepEqual(expandedStates, [true, false, false, false]);
	assert.deepEqual(statuses, [
		"Tool display mode: full",
		"Tool display mode: compact",
		"Tool display mode: command",
		"Tool display mode: friendly",
	]);
});

test("skill messages stay collapsed and image binding does not leak skill text", () => {
	const skillText = `<skill name="diagnosing-bugs" location="/tmp/diagnosing-bugs/SKILL.md">\nfull skill content\n</skill>\n\n[Image attached: screenshot.png] inspect this`;
	const instance = { chatContainer: { children: [] } };
	interactivePrototype.addMessageToChat.call(instance, {
		role: "user",
		timestamp: Date.now(),
		testSkillInvocation: true,
		content: [
			{ type: "text", text: skillText },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		],
	});

	const skill = instance.chatContainer.children.find((component) => component instanceof SkillInvocationMessageComponent);
	const imageUser = instance.chatContainer.children.find((component) => component instanceof UserMessageComponent);
	assert.ok(skill);
	assert.ok(imageUser);
	assert.equal(skill.expanded, false);
	assert.equal(imageUser.text, "inspect this");
	assert.doesNotMatch(imageUser.text, /<skill|full skill content/);

	const noImageInstance = { chatContainer: { children: [] } };
	interactivePrototype.addMessageToChat.call(noImageInstance, {
		role: "user",
		timestamp: Date.now(),
		testSkillInvocation: true,
		content: [{ type: "text", text: `${skillText}\n\nno image question` }],
	});
	const noImageSkill = noImageInstance.chatContainer.children.find((component) => component instanceof SkillInvocationMessageComponent);
	assert.ok(noImageSkill);
	assert.equal(noImageSkill.expanded, false);
	legacyBindings = 0;
});

test("user message timestamps sit below the padded background band", () => {
	globalThis[Symbol.for("pi.custom-pi.user-message-time")].getTheme = () => activeTheme;
	const message = new UserMessageComponent("spacing test");
	message.customPiTimestamp = new Date(2026, 6, 20, 10, 34).getTime();

	const lines = message.render(80);
	const timestampLine = lines.at(-2);

	assert.equal(lines.at(-1), " ".repeat(80));
	assert.equal(stripTerminalControls(lines.at(-3)), " ".repeat(80));
	assert.equal(stripTerminalControls(timestampLine), "2026.7.20 10:34");
	assert.equal(/\x1b\[(?:48;2|48;5);/.test(timestampLine), false);
});

test("user message bands have one cell of padding on every side", () => {
	globalThis[Symbol.for("pi.custom-pi.user-message-time")].getTheme = () => activeTheme;
	const message = new UserMessageComponent("x".repeat(200));
	message.customPiTimestamp = new Date(2026, 6, 20, 10, 34).getTime();

	const lines = message.render(100);
	const plainLines = lines.map(stripTerminalControls);
	assert.equal(plainLines[0], " ".repeat(100));
	assert.equal(plainLines[1], ` ${"x".repeat(98)} `);
	assert.equal(plainLines[2], ` ${"x".repeat(98)} `);
	assert.equal(plainLines[3], ` ${"x".repeat(4)}${" ".repeat(95)}`);
	assert.equal(plainLines.at(-3), " ".repeat(100));
	assert.equal(plainLines.at(-2), "2026.7.20 10:34");
	assert.equal(/\x1b\[(?:48;2|48;5);/.test(lines.at(-2)), false);
	assert.equal(lines.some((line) => /\x1b\[(?:48;2|48;5);/.test(line)), true);

	const short = new UserMessageComponent("short message");
	short.customPiTimestamp = message.customPiTimestamp;
	const shortLine = stripTerminalControls(short.render(100)[1]);
	assert.equal(shortLine.startsWith(" short message"), true);
	assert.equal(shortLine.length, 100);
});

test("setExpanded discards image records retained from the pre-thumbnail patch", () => {
	let invalidations = 0;
	const message = new UserMessageComponent("legacy image message");
	message.customPiImages = [{
		component: { invalidate: () => invalidations++ },
		dimensions: { widthPx: 640, heightPx: 480 },
	}];

	assert.doesNotThrow(() => message.setExpanded(false));
	assert.equal(invalidations, 1);
	assert.equal(message.customPiImages, undefined);
});

test("setExpanded invalidates both current image sizes", () => {
	let thumbnailInvalidations = 0;
	let expandedInvalidations = 0;
	const message = new UserMessageComponent("current image message");
	const images = [{
		dimensions: { widthPx: 640, heightPx: 480 },
		thumbnail: { invalidate: () => thumbnailInvalidations++ },
		expanded: { invalidate: () => expandedInvalidations++ },
	}];
	message.customPiImages = images;

	message.setExpanded(true);
	assert.equal(thumbnailInvalidations, 1);
	assert.equal(expandedInvalidations, 1);
	assert.equal(message.customPiImages, images);
});

test("the V2 message patch replaces images produced by a retained V1 binding", () => {
	const instance = { chatContainer: { children: [] } };
	interactivePrototype.addMessageToChat.call(instance, {
		role: "user",
		timestamp: 1_784_393_207_131,
		content: [
			{ type: "text", text: "[Image attached: legacy.png]" },
			{
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			},
		],
	});

	assert.equal(legacyBindings, 1);
	assert.equal(instance.chatContainer.children.length, 1);
	const [image] = instance.chatContainer.children[0].customPiImages;
	assert.ok(image.thumbnail);
	assert.ok(image.expanded);
	assert.equal(image.component, undefined);
});
