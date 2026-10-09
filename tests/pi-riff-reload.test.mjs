import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import test, { after, beforeEach } from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = process.env.PI_RIFF_TEST_EXTENSION ?? join(repositoryRoot, "extensions", "pi-riff.ts");
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
let piRoot = dirname(piExecutable);
while (dirname(piRoot) !== piRoot && !existsSync(join(piRoot, loaderRelativePath))) {
	piRoot = dirname(piRoot);
}
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
const { AssistantMessageComponent, CustomEditor, FooterComponent, InteractiveMode, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent, parseSkillBlock,
	createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
	createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition } = await import(indexUrl.href);
const { Container, visibleWidth, Image, getCapabilities, setCapabilities, getCellDimensions, setCellDimensions } = await import(tuiUrl.href);
const themeExports = await import(themeUrl.href);
const { initTheme, theme: activeTheme } = themeExports;
initTheme("dark");
const footerTimerState = globalThis[Symbol.for("pi.custom-pi.footer-timer")] ??= {};
footerTimerState.getTheme = () => activeTheme;
beforeEach(() => {
	// Component fixtures run as an active session; lifecycle tests may clear these.
	footerTimerState.getTheme = () => activeTheme;
	const userState = globalThis[Symbol.for("pi.custom-pi.user-message-time")];
	if (userState) userState.getTheme = () => activeTheme;
});

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

// Capture output before Riff touches ToolExecutionComponent prototypes.
const nativeToolCases = [
	["read", createReadToolDefinition(repositoryRoot), { path: "example.ts" }],
	["bash", createBashToolDefinition(repositoryRoot), { command: "printf hello" }],
	["edit", createEditToolDefinition(repositoryRoot), { path: "example.ts", oldText: "old", newText: "new", edits: [{ oldText: "old", newText: "new" }] }],
	["write", createWriteToolDefinition(repositoryRoot), { path: "example.ts", content: "hello" }],
	["grep", createGrepToolDefinition(repositoryRoot), { pattern: "hello", path: "." }],
	["find", createFindToolDefinition(repositoryRoot), { pattern: "*.ts", path: "." }],
	["ls", createLsToolDefinition(repositoryRoot), { path: "." }],
	["unknown", undefined, { query: "hello" }],
	["custom", {
		renderCall: (_args, _theme, ctx) => ({ render: () => [`custom pad=${ctx.outputPad}`], invalidate() {} }),
		renderResult: (_result, options, _theme, ctx) => ({ render: () => [`custom ${options.expanded ? "expanded" : "preview"} duration=${ctx.durationMs}`], invalidate() {} }),
	}, { query: "hello" }],
];
function toolRenderMatrix(expanded) {
	const records = [];
	for (const [name, definition, args] of nativeToolCases) {
		for (const outputPad of [0, 1, 3]) {
			const component = new ToolExecutionComponent(name, "native-compare", args,
				{ outputPad, showImages: false }, definition, { requestRender() {} }, repositoryRoot);
			component.setExpanded(expanded);
			component.markExecutionStarted();
			component.setArgsComplete();
			for (const [isError, isPartial] of [[false, true], [false, false], [true, false]]) {
				component.updateResult({ content: [{ type: "text", text: Array.from({ length: 18 }, (_, i) => `line ${i}: 中文 hello`).join("\n") }],
					details: { diff: "-old\n+new", firstChangedLine: 1 }, isError, durationMs: 1250 }, isPartial);
				for (const width of [20, 80]) {
					records.push({ name, outputPad, isError, isPartial, width, lines: component.render(width) });
				}
			}
		}
	}
	return records;
}
const nativeCompactRendering = toolRenderMatrix(false);
const nativeFullRendering = toolRenderMatrix(true);
const nativeSwitchTool = new ToolExecutionComponent("unknown", "mode-switch", { query: "hello" }, {}, undefined,
	{ requestRender() {} }, repositoryRoot);
const switchResult = { content: [{ type: "text", text: "first line\nsecond line" }], details: undefined, isError: false };
nativeSwitchTool.updateResult(switchResult);
const nativeSwitchLines = nativeSwitchTool.render(80);

const loaded = await loadExtensions([extensionPath], repositoryRoot);
assert.deepEqual(loaded.errors, []);
const customPiExtension = loaded.extensions.find((extension) => extension.resolvedPath === extensionPath);
assert.ok(customPiExtension);
assert.equal(footerPrototype.compactSessionIdentityPatched, true);

const stripTerminalControls = (line) => line
	.replace(/\x1b\]133;[ABC]\x07/g, "")
	.replace(/\x1b\[[0-9;]*m/g, "");

test("Pi session name is the only title source", () => {
	assert.equal(customPiExtension.tools.has("set_ctx_title"), false, "Riff displays names but must not own the naming tool");
	assert.equal(customPiExtension.commands.has("ctx-title"), false);
	assert.equal(customPiExtension.commands.has("workspace-context"), false);
	assert.equal(customPiExtension.tools.has("set_workspace_context"), false);

	const source = readFileSync(extensionPath, "utf8");
	assert.doesNotMatch(source, /registerCommand\("ctx-title"/);
	assert.doesNotMatch(source, /appendEntry<CtxTitleEntry>/);
	assert.doesNotMatch(source, /setStatus\(CTX_TITLE_STATUS_KEY/);
});

test("session start restores the native editor and hides only the working indicator", async () => {
	const editorFactories = [];
	const workingVisibility = [];
	let hook;
	const ui = new Proxy({
		theme: activeTheme,
		setEditorComponent: (factory) => editorFactories.push(factory),
		setWorkingVisible: (visible) => workingVisibility.push(visible),
		setWidget: (_key, factory) => { hook = factory({ requestRender() {} }); },
	}, { get: (target, key) => target[key] ?? (() => undefined) });
	const { getSessionName, getAllTools } = loaded.runtime;
	loaded.runtime.getSessionName = () => "test session";
	loaded.runtime.getAllTools = () => [];
	try {
		for (const handler of customPiExtension.handlers.get("session_start") ?? []) {
			await handler({}, { mode: "tui", cwd: repositoryRoot, ui,
				sessionManager: { getBranch: () => [], getEntries: () => [] } });
		}
	} finally {
		Object.assign(loaded.runtime, { getSessionName, getAllTools });
	}
	assert.deepEqual(editorFactories, [undefined]);
	assert.deepEqual(workingVisibility, [false]);
	assert.deepEqual(hook.render(80), []);
	const changedTheme = { ...activeTheme, testThemeChange: true };
	ui.theme = changedTheme;
	assert.equal(globalThis[Symbol.for("pi.custom-pi.user-message-time")].getTheme(), changedTheme);
	assert.equal(footerTimerState.getTheme(), changedTheme);
	ui.theme = activeTheme;
	hook.dispose();
	const source = readFileSync(extensionPath, "utf8");
	assert.doesNotMatch(source, /class BorderlessEditor|extends CustomEditor/);
});

test("session start restores the actual official editor with both borders and preserves input", async () => {
	const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {}, setFocus() {} };
	const keybindings = { matches: () => false, getKeys: () => [] };
	const defaultEditor = new CustomEditor(tui, themeExports.getEditorTheme(), keybindings, { embedWorkingStatus: true });
	const text = "保留当前输入\n第二行";
	const instance = { defaultEditor, editor: { getText: () => text }, editorContainer: new Container(),
		disposeActiveSelector() {}, ui: tui, activeStatusIndicator: undefined };
	const ui = new Proxy({ theme: activeTheme,
		setEditorComponent: (factory) => interactivePrototype.setCustomEditorComponent.call(instance, factory),
		setWidget: (_key, factory) => factory(tui),
	}, { get: (target, key) => target[key] ?? (() => undefined) });
	const previous = { getSessionName: loaded.runtime.getSessionName, getAllTools: loaded.runtime.getAllTools };
	loaded.runtime.getSessionName = () => "editor test";
	loaded.runtime.getAllTools = () => [];
	try {
		for (const handler of customPiExtension.handlers.get("session_start") ?? []) {
			await handler({}, { mode: "tui", cwd: repositoryRoot, ui,
				sessionManager: { getBranch: () => [], getEntries: () => [] } });
		}
		assert.equal(instance.editor, defaultEditor, "must use Pi's existing default editor, not a subclass");
		assert.equal(instance.editor.getText(), text);
		for (const width of [20, 80]) {
			const lines = instance.editor.render(width).map(stripTerminalControls);
			assert.match(lines[0], /^─+$/);
			assert.match(lines.at(-1), /^─+$/);
			assert.equal(visibleWidth(lines[0]), width);
		}
	} finally {
		Object.assign(loaded.runtime, previous);
		for (const handler of customPiExtension.handlers.get("session_shutdown") ?? []) await handler({}, {});
	}
});

test("retained renderers survive real context invalidation and release theme callbacks on shutdown", async () => {
	const { ExtensionRunner } = await import(pathToFileURL(join(piRoot, "dist", "core", "extensions", "runner.js")).href);
	const { createExtensionRuntime } = await import(pathToFileURL(join(piRoot, "dist", "core", "extensions", "loader.js")).href);
	const manager = { getBranch: () => [], getEntries: () => [], getCwd: () => repositoryRoot,
		getSessionName: () => "test", getSessionId: () => "retained", getLeafId: () => null, getEntryCount: () => 0 };
	const runner = new ExtensionRunner([], createExtensionRuntime(), repositoryRoot, manager, {});
	let hook;
	const ui = { theme: activeTheme, setEditorComponent() {}, setWorkingVisible() {},
		setWidget(_key, factory) { hook = factory({ requestRender() {} }); },
		setToolsExpanded() {}, setHiddenThinkingLabel() {} };
	runner.setUIContext(ui, "tui");
	const ctx = runner.createContext();
	const userState = globalThis[Symbol.for("pi.custom-pi.user-message-time")];
	const previous = { getSessionName: loaded.runtime.getSessionName, getAllTools: loaded.runtime.getAllTools };
	const previousThemes = { footer: footerTimerState.getTheme, user: userState.getTheme };
	loaded.runtime.getSessionName = () => "test";
	loaded.runtime.getAllTools = () => [];
	try {
		for (const handler of customPiExtension.handlers.get("session_start") ?? []) await handler({}, ctx);
		const footer = new FooterComponent({ state: { thinkingLevel: "off" }, sessionManager: manager,
			modelRuntime: { isUsingSubscription: () => false }, getContextUsage: () => undefined }, {
			getAvailableProviderCount: () => 0, getExtensionStatuses: () => new Map(), getGitBranch: () => null });
		const message = new UserMessageComponent("重载后仍能显示", Date.now());
		for (const handler of customPiExtension.handlers.get("agent_start") ?? []) await handler({}, ctx);
		runner.invalidate();
		assert.throws(() => ctx.ui, /ctx is stale/, "exercise Pi's actual stale-context guard");
		assert.doesNotThrow(() => footer.render(80), "footer must not read the invalidated ctx");
		assert.doesNotThrow(() => message.render(80), "user-message renderer must not read the invalidated ctx");
		assert.equal(hook.render(80).length, 1, "busy widget must not read the invalidated ctx");
		await new Promise((resolve) => setTimeout(resolve, 100));
		const changedTheme = { ...activeTheme, testThemeChange: true };
		runner.getUIContext().theme = changedTheme;
		assert.equal(footerTimerState.getTheme(), changedTheme);
		assert.equal(userState.getTheme(), changedTheme);
		for (const handler of customPiExtension.handlers.get("session_shutdown") ?? []) await handler({}, {});
		assert.equal(footerTimerState.getTheme, undefined);
		assert.equal(userState.getTheme, undefined);
		assert.doesNotThrow(() => footer.render(80));
		assert.doesNotThrow(() => message.render(80));
		assert.deepEqual(hook.render(80), []);
		hook.dispose();
	} finally {
		for (const handler of customPiExtension.handlers.get("session_shutdown") ?? []) await handler({}, {});
		Object.assign(loaded.runtime, previous);
		footerTimerState.getTheme = previousThemes.footer;
		userState.getTheme = previousThemes.user;
	}
});

test("footer shows provider with the model identity", () => {
	const footer = new FooterComponent({
		state: {
			model: {
				contextWindow: 272_000,
				id: "gpt-5.6-sol",
				provider: "openai-codex",
				reasoning: true,
			},
			thinkingLevel: "xhigh",
		},
		sessionManager: {
			getCwd: () => repositoryRoot,
			getEntryCount: () => 0,
			getSessionId: () => "footer-test",
			getLeafId: () => null,
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		modelRuntime: {
			isUsingOAuth: () => false,
			isUsingSubscription: () => false,
		},
		getContextUsage: () => ({ contextWindow: 272_000, percent: 57.6, tokens: 157_000 }),
	}, {
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map(),
		getGitBranch: () => "main",
	});

	const stats = stripTerminalControls(footer.render(100)[1]).trimEnd();
	assert.equal(stats, "157k/272k(57.6%) • openai-codex/gpt-5.6-sol(xhigh)");
});

function footerFixture(entries = []) {
	let scans = 0;
	let leaf = "leaf";
	const model = { id: "test-model", provider: "test-provider", reasoning: true, contextWindow: 10000 };
	const session = { model, state: { model, thinkingLevel: "high" },
		sessionManager: { getCwd: () => repositoryRoot, getEntryCount: () => entries.length, getSessionId: () => "test",
			getLeafId: () => leaf, getEntries: () => { scans++; return entries; }, getSessionName: () => undefined },
		modelRuntime: { isUsingOAuth: () => true, isUsingSubscription: () => false },
		getContextUsage: () => ({ contextWindow: session.routedModel?.model.contextWindow ?? 10000, percent: 10, tokens: 1000 }),
	};
	const footer = new FooterComponent(session, { getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map(), getGitBranch: () => undefined });
	return { footer, session, entries, scans: () => scans, moveLeaf: () => { leaf += "next"; } };
}
const sampleUsage = () => ({ input: 100, output: 20, cacheRead: 30, cacheWrite: 10,
	totalTokens: 160, cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } });

test("footer shares native accounting for assistant, tool, standalone and summary usage", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: sampleUsage() } },
		{ type: "message", message: { role: "toolResult", usage: sampleUsage() } },
		... ["usage", "compaction", "branch_summary"].map((type) => ({ type, usage: sampleUsage() })),
	];
	const { footer, session } = footerFixture(entries);
	session.modelRuntime.isUsingSubscription = () => true;
	const line = stripTerminalControls(footer.render(180)[1]);
	assert.match(line, /↑500 ↓100 R150 W50 CH21\.4% \$0\.500 \(sub\)/);
});

test("footer reuses the native cache and invalidates on append, leaf, model and session changes", () => {
	const f = footerFixture([{ type: "usage", usage: sampleUsage() }]);
	for (let i = 0; i < 10; i++) f.footer.render(120);
	assert.equal(f.scans(), 1, "unchanged frames must not rescan entries");
	f.entries.push({ type: "usage", usage: sampleUsage() });
	assert.match(stripTerminalControls(f.footer.render(120)[1]), /↑200/);
	assert.equal(f.scans(), 2);
	f.moveLeaf(); f.footer.render(120); assert.equal(f.scans(), 3);
	f.session.routedModel = { model: { ...f.session.model, id: "routed" } };
	f.footer.render(120); assert.equal(f.scans(), 4);
	const other = footerFixture([{ type: "usage", usage: sampleUsage() }]);
	f.footer.setSession(other.session);
	assert.match(stripTerminalControls(f.footer.render(120)[1]), /↑100/);
	assert.equal(other.scans(), 1);
});

test("footer subscription detection is not OAuth detection and shows actual routed model", () => {
	const { footer, session } = footerFixture();
	assert.doesNotMatch(stripTerminalControls(footer.render(180)[1]), /\(sub\)/);
	session.modelRuntime.isUsingSubscription = () => true;
	assert.match(stripTerminalControls(footer.render(180)[1]), /\(sub\)/);
	session.routedModel = { model: { provider: "actual", id: "routed", contextWindow: 20000, reasoning: true }, thinkingLevel: "xhigh" };
	assert.match(stripTerminalControls(footer.render(180)[1]), /test-provider\/test-model\(high\) → actual\/routed\(xhigh\)/);
	session.modelRuntime.isUsingSubscription = () => false;
	session.routedModel = undefined;
	session.state.model.provider = "kimi-coding";
	assert.match(stripTerminalControls(footer.render(180)[1]), /\(sub\)/);
});

test("Command and Friendly honor outputPad and stay within narrow widths including errors", async () => {
	const command = customPiExtension.commands.get("tool-style");
	try {
		for (const mode of ["command", "friendly"]) {
			await command.handler(mode, { ui: { notify() {}, setToolsExpanded() {} } });
			for (const outputPad of [0, 1, 3]) {
				const tool = new ToolExecutionComponent("read", "padding", { path: "中文-file.ts" }, { outputPad }, undefined,
					{ requestRender() {} }, repositoryRoot);
				tool.updateResult({ content: [{ type: "text", text: "bad failure" }], isError: true, durationMs: 100 });
				for (const width of [1, 2, 8, 40]) {
					const lines = tool.render(width);
					assert.ok(lines.every((line) => visibleWidth(line) <= width), `${mode} pad=${outputPad} width=${width}`);
					if (width === 40) {
						assert.ok(stripTerminalControls(lines[0]).startsWith(" ".repeat(outputPad)));
						assert.ok(stripTerminalControls(lines[0]).endsWith(" ".repeat(outputPad)));
					}
				}
			}
		}
	} finally { await command.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } }); }
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
			const extension = extensionsResult.extensions.find((candidate) => candidate.entryRenderers.has("compact-agent-timing"));
			const oldTimingEntry = manager.getEntries().filter(
				(entry) => entry.type === "custom" && entry.customType === "compact-agent-timing",
			).at(-1);
			const renderedTiming = extension.entryRenderers.get("compact-agent-timing")(
				oldTimingEntry, {}, { fg: (_color, text) => text },
			).render(100)[0].replace(/\\x1b\\[[0-9;]*m/g, "").trimEnd();
			const inferredTiming = renderedTiming.slice(0, renderedTiming.lastIndexOf(" | "));
			session.setSessionName("Native title");
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
		inferredTiming: "第 2 轮 | 2s / 3s",
		updatedName: "Native title",
		legacyEntryCount: 1,
	});
});

test("Riff loading and timing animate above the native editor without using its hidden indicator", async () => {
	let widget;
	let redraws = 0;
	const messages = [];
	const factories = [];
	const previousName = loaded.runtime.getSessionName;
	const previousAppend = loaded.runtime.appendEntry;
	const entries = [];
	loaded.runtime.appendEntry = (type, data) => entries.push({ type, data });
	const previousNow = Object.getOwnPropertyDescriptor(performance, "now");
	let clock = 0;
	Object.defineProperty(performance, "now", { value: () => clock, configurable: true });
	loaded.runtime.getSessionName = () => "loading test";
	const ui = new Proxy({ theme: activeTheme,
		setWorkingMessage: (message) => messages.push(message),
		setEditorComponent: (factory) => factories.push(factory),
		setWidget: (_key, factory) => { widget = factory({ requestRender() { redraws++; } }); },
	}, { get: (target, key) => target[key] ?? (() => undefined) });
	const ctx = { mode: "tui", cwd: repositoryRoot, ui, sessionManager: { getBranch: () => [], getEntries: () => [] } };
	try {
		for (const handler of customPiExtension.handlers.get("session_start") ?? []) await handler({}, ctx);
		assert.deepEqual(widget.render(80), []);
		for (const handler of customPiExtension.handlers.get("agent_start") ?? []) await handler({}, ctx);
		const first = widget.render(80)[0];
		assert.ok(first, "busy status must remain visible while the native working indicator is hidden");
		assert.match(stripTerminalControls(first), /^\s*[◐◓◑◒] 第 1 轮 \| 0s \/ 0s\s*$/);
		assert.ok(first.includes(activeTheme.fg("warning", activeTheme.bold("第 1 轮"))));
		clock = 160;
		assert.notEqual(widget.render(80)[0], first, "spinner should advance");
		clock = 2100;
		assert.match(stripTerminalControls(widget.render(80)[0]), /2s \/ 2s/);
		assert.ok(widget.render(8).every((line) => visibleWidth(line) <= 8));
		await new Promise((resolve) => setTimeout(resolve, 180));
		assert.ok(redraws > 1, "loading must redraw even without streaming assistant text");
		assert.deepEqual(factories, [undefined]);
		assert.deepEqual(messages, [], "Riff must not write to the native hidden working label");
		for (const handler of customPiExtension.handlers.get("agent_end") ?? []) await handler({}, ctx);
		assert.equal(widget.render(80).length, 1, "keep loading until settled, including continuations");
		for (const handler of customPiExtension.handlers.get("agent_settled") ?? []) await handler({}, ctx);
		assert.deepEqual(widget.render(80), []);
		assert.equal(entries.length, 1);
		for (const handler of customPiExtension.handlers.get("agent_start") ?? []) await handler({}, ctx);
		assert.match(stripTerminalControls(widget.render(80)[0]), /第 2 轮/);
		for (const handler of customPiExtension.handlers.get("agent_settled") ?? []) await handler({ aborted: true }, ctx);
		assert.deepEqual(widget.render(80), []);
		for (const handler of customPiExtension.handlers.get("agent_start") ?? []) await handler({}, ctx);
		widget.dispose();
		const afterDispose = redraws;
		assert.deepEqual(widget.render(80), []);
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(redraws, afterDispose, "disposing the widget must stop its animation timer");
		for (const handler of customPiExtension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		assert.deepEqual(widget.render(80), []);
	} finally {
		for (const handler of customPiExtension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		widget?.dispose();
		loaded.runtime.getSessionName = previousName;
		loaded.runtime.appendEntry = previousAppend;
		if (previousNow) Object.defineProperty(performance, "now", previousNow);
		else delete performance.now;
	}
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
	assert.equal(line, "第 4 轮 | 12s / 1m 15s | 2026.7.27 17:11");
	assert.ok(rawLine.includes(activeTheme.fg("accent", activeTheme.bold("第 4 轮"))));
	assert.ok(rawLine.includes(activeTheme.fg("accent", activeTheme.bold("12s / 1m 15s"))));
	assert.equal(rawLine.includes(activeTheme.fg("accent", activeTheme.bold("第 4 轮 |"))), false);
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

test("Friendly is the default and compact-tools returns to it", async () => {
	const state = globalThis[Symbol.for("pi.custom-pi.minimal-tool-state")];
	assert.equal(state.displayMode, "friendly");
	const command = customPiExtension.commands.get("compact-tools");
	assert.match(command.description, /Friendly rendering/);
	state.displayMode = "full";
	await command.handler("", { ui: { setToolsExpanded() {}, notify() {} } });
	assert.equal(state.displayMode, "friendly");
});

test("Riff loads alongside a naming extension without duplicate set_ctx_title registration", () => {
	const script = `
		import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { pathToFileURL } from "node:url";
		const agentDir = mkdtempSync(join(tmpdir(), "pi-riff-naming-"));
		mkdirSync(join(agentDir, "extensions"));
		symlinkSync(${JSON.stringify(extensionPath)}, join(agentDir, "extensions", "pi-riff.ts"));
		writeFileSync(join(agentDir, "extensions", "ctx-name-skill.ts"), ${JSON.stringify('export default function(pi) { pi.registerTool({ name: "set_ctx_title", label: "Set Session Name", description: "Owned by the explicit naming extension", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, async execute(_id, args) { pi.setSessionName(args.title); return { content: [{ type: "text", text: args.title }], details: { sessionName: args.title } }; } }); }')});
		const { createAgentSession } = await import(pathToFileURL(join(${JSON.stringify(piRoot)}, "dist", "core", "sdk.js")).href);
		const { SessionManager } = await import(pathToFileURL(join(${JSON.stringify(piRoot)}, "dist", "core", "session-manager.js")).href);
		let session;
		try {
			const result = await createAgentSession({ cwd: ${JSON.stringify(repositoryRoot)}, agentDir,
				sessionManager: SessionManager.inMemory(${JSON.stringify(repositoryRoot)}) });
			session = result.session;
			const ui = new Proxy({ theme: {}, getToolsExpanded: () => false }, { get: (target, key) => target[key] ?? (() => undefined) });
			await session.bindExtensions({ mode: "rpc", uiContext: ui });
			const owners = result.extensionsResult.extensions.filter((extension) => extension.tools.has("set_ctx_title"));
			await owners[0].tools.get("set_ctx_title").definition.execute("name", { title: "Naming still works" });
			console.log(JSON.stringify({ errors: result.extensionsResult.errors, ownerCount: owners.length,
				owner: owners[0].resolvedPath.split("/").at(-1), name: session.sessionName }));
		} finally { session?.dispose(); rmSync(agentDir, { recursive: true, force: true }); }
	`;
	const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module"], { encoding: "utf8", input: script }));
	assert.deepEqual(result, { errors: [], ownerCount: 1, owner: "ctx-name-skill.ts", name: "Naming still works" });
});

test("session initialization preserves other tools' business schemas including intent", () => {
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
				properties: { intent: { type: "string", description: "Business intent" }, _display_summary: { type: "string" }, query: { type: "string" } },
				required: ["query", "intent", "_display_summary"],
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
		hasLegacyProperty: true,
		hasLegacyRequired: true,
		hasIntentProperty: true,
		hasIntentRequired: true,
	});
});

test("Friendly labels are local, deterministic, and all four modes are selectable", async () => {
	const toolCallHandlers = customPiExtension.handlers.get("tool_call") ?? [];
	assert.equal(toolCallHandlers.length, 0);
	const toolCall = {
		type: "tool_call",
		toolName: "probe",
		toolCallId: "probe-call",
		input: { query: "raw query", intent: "检查后台会话状态", _display_summary: "legacy summary" },
	};
	for (const handler of toolCallHandlers) await handler(toolCall, {});
	assert.deepEqual(toolCall.input, { query: "raw query", intent: "检查后台会话状态", _display_summary: "legacy summary" });

	const contextHandlers = customPiExtension.handlers.get("context") ?? [];
	assert.equal(contextHandlers.length, 0);
	const originalArguments = { query: "raw query", intent: "检查后台会话状态", _display_summary: "legacy summary" };
	const contextEvent = {
		type: "context",
		messages: [{ role: "assistant", content: [{ type: "toolCall", id: "probe-call", name: "probe", arguments: originalArguments }] }],
	};
	for (const handler of contextHandlers) await handler(contextEvent, {});
	assert.deepEqual(contextEvent.messages[0].content[0].arguments, originalArguments);
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
	assert.deepEqual(component.args, { command: "git status --short" });
	assert.equal(expandedStates.at(-1), true);
	assert.deepEqual(notifications.map((entry) => entry.message), [
		"Tool display mode: friendly",
		"Tool display mode: command",
		"Tool display mode: full",
	]);
	await toolStyle.handler("friendly", ctx);
});

test("collapsed Thinking never renders its full child and keeps native label and padding", () => {
	for (const completed of [false, true]) {
		const message = { role: "assistant", timestamp: Date.now(),
			content: [{ type: "thinking", thinking: "long thought\n".repeat(5000) }],
			...(completed ? { stopReason: "stop" } : {}) };
		const component = new AssistantMessageComponent(message, true, undefined, "处理中…", 3);
		const wrapper = component.contentContainer.children.find((child) => child.constructor.name === "CollapsibleThinkingComponent");
		assert.ok(wrapper);
		let renders = 0;
		wrapper.content.render = () => { renders++; return ["SHOULD NOT RENDER"]; };
		for (const width of [20, 80]) {
			const line = component.render(width).map(stripTerminalControls).find((line) => line.trim());
			assert.equal(renders, 0, "collapsed rows must not render the full child");
			assert.ok(line.startsWith("   "));
			assert.match(line, completed ? /Thinking/ : /处理中…/);
		}
		assert.equal(renders, 0);
	}
});

test("clipboard rejects oversized files before reading and bounds reads if a file grows", async () => {
	const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
	const handlers = customPiExtension.handlers.get("input") ?? [];
	const event = { source: "interactive", text: path, images: [] };
	const original = { readFileSync: fs.readFileSync, readSync: fs.readSync };
	let reads = 0;
	try {
		fs.writeFileSync(path, "");
		fs.truncateSync(path, 20 * 1024 * 1024 + 1);
		fs.readFileSync = (...args) => { reads++; return original.readFileSync(...args); };
		fs.readSync = (...args) => { reads++; return original.readSync(...args); };
		syncBuiltinESMExports();
		for (const handler of handlers) assert.equal(await handler(event, {}), undefined);
		assert.equal(reads, 0, "oversized files must be rejected before reading");
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
		fs.writeFileSync(path, png);
		let bytesRequested = 0;
		fs.readSync = (...args) => {
			if (bytesRequested === 0) fs.appendFileSync(path, Buffer.alloc(1024 * 1024));
			bytesRequested += args[3];
			return original.readSync(...args);
		};
		syncBuiltinESMExports();
		for (const handler of handlers) assert.equal(await handler(event, {}), undefined);
		assert.ok(bytesRequested <= png.length + 1, "growth must not cause an unbounded read");
		assert.ok(bytesRequested > 0);
	} finally {
		Object.assign(fs, original); syncBuiltinESMExports(); fs.rmSync(path, { force: true });
	}
});

test("tool renderers receive business intent unchanged in both arguments and context", async () => {
	const command = customPiExtension.commands.get("tool-style");
	const args = { intent: "approve", _display_summary: "business value" };
	let calls = 0;
	let results = 0;
	const definition = {
		renderCall(input, _theme, context) {
			assert.deepEqual(input, args); assert.deepEqual(context.args, args); calls++;
			return { render: () => [input.intent], invalidate() {} };
		},
		renderResult(_result, _options, _theme, context) {
			assert.deepEqual(context.args, args); results++;
			return { render: () => [context.args._display_summary], invalidate() {} };
		},
	};
	try {
		for (const mode of ["compact", "full"]) {
			await command.handler(mode, { ui: { notify() {}, setToolsExpanded() {} } });
			const tool = new ToolExecutionComponent("business", mode, args, {}, definition, { requestRender() {} }, repositoryRoot);
			tool.setExpanded(mode === "full");
			tool.updateResult({ content: [], isError: false });
			assert.deepEqual(tool.args, args);
			assert.match(tool.render(80).map(stripTerminalControls).join("\n"), /approve/);
		}
		assert.ok(calls > 0 && results > 0);
	} finally { await command.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } }); }
});

test("per-block Thinking clicks expand and collapse without changing the global visibility toggle", () => {
	const component = new AssistantMessageComponent({ role: "assistant", timestamp: Date.now(), stopReason: "stop",
		content: [{ type: "thinking", thinking: "first thought\nsecond thought" }] }, true);
	const event = { type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: 1,
		shift: false, alt: false, ctrl: false };
	const findWrapper = () => component.contentContainer.children.find((child) => child.constructor.name === "CollapsibleThinkingComponent");
	assert.equal(findWrapper().handleMouse(event)?.handled, true);
	assert.equal(component.hideThinkingBlock, true);
	assert.match(component.render(80).map(stripTerminalControls).join("\n"), /first thought/);
	assert.equal(findWrapper().handleMouse(event)?.handled, true);
	assert.doesNotMatch(component.render(80).map(stripTerminalControls).join("\n"), /first thought/);
});

test("clipboard attaches valid PNGs once and rejects empty, invalid and nonregular paths", async () => {
	const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
	const link = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
	const handlers = customPiExtension.handlers.get("input") ?? [];
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	const run = async (text) => {
		let result;
		for (const handler of handlers) result = await handler({ source: "interactive", text, images: [] }, {});
		return result;
	};
	try {
		fs.writeFileSync(path, png);
		const attached = await run(`${path} ${path}`);
		assert.equal(attached.action, "transform");
		assert.equal(attached.images.length, 1);
		assert.equal(attached.images[0].data, png.toString("base64"));
		assert.equal(attached.images[0].mimeType, "image/png");
		if (fs.constants.O_NOFOLLOW) {
			fs.symlinkSync(path, link);
			assert.equal(await run(link), undefined);
		}
		fs.writeFileSync(path, ""); assert.equal(await run(path), undefined);
		fs.writeFileSync(path, "not an image"); assert.equal(await run(path), undefined);
		fs.rmSync(path); fs.mkdirSync(path); assert.equal(await run(path), undefined);
	} finally { fs.rmSync(path, { recursive: true, force: true }); fs.rmSync(link, { force: true }); }
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
	assert.ok(mixedRawLines[bodyIndex - 1].includes(activeTheme.getFgAnsi("accent")));
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
	assert.ok(newerMarker?.includes(activeTheme.getFgAnsi("accent")));
	assert.ok(["◐", "◓", "◑", "◒"].some((frame) => newerMarker?.includes(activeTheme.fg("accent", activeTheme.bold(frame)))));
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
	assert.ok(bodyRawLines[bodyIndex - 1].includes(activeTheme.getFgAnsi("accent")));
	assert.ok(["◐", "◓", "◑", "◒"].some((frame) => bodyRawLines[bodyIndex - 1].includes(activeTheme.fg("accent", activeTheme.bold(frame)))));
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
	read.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree" }], details: undefined, isError: false, durationMs: 1250 });
	const readLine = read.render(80).map(stripTerminalControls).find((line) => line.includes("read"));
	assert.ok(readLine);
	assert.match(readLine, /read docs\/agents\/issue-tracker\.md/);
	const styledReadLine = read.render(80).find((line) => line.includes("issue-tracker.md"));
	assert.ok(styledReadLine.includes(activeTheme.fg("success", activeTheme.bold("issue-tracker.md"))));
	assert.doesNotMatch(readLine, new RegExp(repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(readLine, /3 lines\s+1\.3s\s*$/);
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
	command.updateResult({ content: [], details: undefined, isError: false, durationMs: 250 });
	const commandLine = command.render(72).map(stripTerminalControls).find((line) => line.includes("git"));
	assert.ok(commandLine);
	assert.match(commandLine, /^\s*\$ git -C \. status/);
	assert.match(commandLine, /\.\.\..*important-target\.md\s+\d+(?:\.\d+)?(?:ms|s)\s*$/);
	assert.ok(commandLine.length <= 72);
	const styledCommandLine = command.render(100).find((line) => line.includes("status"));
	assert.ok(styledCommandLine.includes(activeTheme.fg("success", activeTheme.bold("git"))));
	assert.ok(styledCommandLine.includes(activeTheme.fg("success", activeTheme.bold("status"))));

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
	assert.ok(styledRgLine.includes(activeTheme.fg("success", activeTheme.bold("rg"))));
	assert.ok(styledRgLine.includes(activeTheme.fg("success", activeTheme.bold('"GLB|STEP|cad_part"'))));
	assert.equal(styledRgLine.includes(activeTheme.fg("success", activeTheme.bold("src"))), false);

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
		assert.ok(line.includes(activeTheme.fg("success", activeTheme.bold(item.semantic))), item.command);
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
	assert.match(stripTerminalControls(line), /^\s*\$ tmux capture-pane/);
	assert.doesNotMatch(stripTerminalControls(line), /sleep 240/);
	assert.ok(line.includes(activeTheme.fg("success", activeTheme.bold("tmux"))));
	assert.ok(line.includes(activeTheme.fg("success", activeTheme.bold("capture-pane"))));
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
	for (const token of ["cd", "node", "--test", "npm", "build:type"]) {
		assert.ok(line.includes(activeTheme.fg("success", activeTheme.bold(token))));
	}
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

test("Friendly labels use operation-specific native tool arguments without model output", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
	const cases = [
		{ tool: "read", args: { path: "/tmp/project/src/app.ts", offset: 20, limit: 10 }, expected: "续读 src/app.ts（20–29 行）" },
		{ tool: "read", args: { path: "/tmp/project/src/app.ts", offset: 1, limit: 2000 }, expected: "读取 src/app.ts", forbidden: "1–2000" },
		{ tool: "read", args: { path: "/tmp/project/.agents/skills/research/SKILL.md", offset: 1, limit: 2000 }, expected: "读取技能说明 research/SKILL.md" },
		{ tool: "read", args: { path: "/tmp/project/assets/logo.png" }, expected: "查看图片 assets/logo.png" },
		{ tool: "read", args: { path: "/tmp/project/very/long/worktree/server/app/agent/sdk_runtime/native/command_transaction.py" }, expected: "读取 native/command_transaction.py", forbidden: "very/long/worktree" },
		{ tool: "edit", args: { path: "/tmp/project/tests/app.test.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, expected: "更新测试 tests/app.test.ts（2 处）" },
		{ tool: "edit", args: { path: "/tmp/project/docs/spec.md", edits: [{ oldText: "a", newText: "b" }] }, expected: "更新文档 docs/spec.md（1 处）" },
		{ tool: "write", args: { path: "/tmp/project/docs/report.md", content: "# Report" }, expected: "生成文档 docs/report.md" },
		{ tool: "grep", args: { pattern: "handleOrder", path: "/tmp/project/src" }, expected: "在 src 搜索 handleOrder" },
		{ tool: "find", args: { pattern: "*.test.ts", path: "/tmp/project/src" }, expected: "在 src 查找 *.test.ts" },
		{ tool: "web_search", args: { query: "", queries: ["Pi extension rendering", "Pi custom tools", "Pi TUI"] }, expected: "搜索网络（3 项）：Pi extension rendering" },
		{ tool: "source_check", args: { claim: "Friendly labels are local" }, expected: "核验事实：Friendly labels are local" },
		{ tool: "fetch_content", args: { url: "", urls: ["https://example.com/docs", "https://pi.dev/docs"], mode: "readable", prompt: "", timestamp: "" }, expected: "获取网页内容（2 项）：example.com/docs" },
		{ tool: "fetch_content", args: { url: "https://example.com/docs", urls: [], mode: "answer", prompt: "Summarize" }, expected: "分析网页内容：example.com/docs" },
		{ tool: "get_search_content", args: { responseId: "r1", findText: ["renderCall"], url: "" }, expected: "在来源中查找：renderCall" },
		{ tool: "get_search_content", args: { responseId: "r1", url: "https://example.com/docs", query: "", offset: 0 }, expected: "读取来源：example.com/docs" },
		{ tool: "set_ctx_title", args: { title: "Friendly 规则" }, expected: "设置会话名：Friendly 规则" },
		{ tool: "set_ctx_title", args: {}, expected: "清除会话名" },
		{ tool: "multi_tool_use.parallel", args: { tool_uses: [{ recipient_name: "functions.read" }, { recipient_name: "functions.read" }] }, expected: "并行读取 2 个文件" },
	];
	for (const [index, item] of cases.entries()) {
		const component = new ToolExecutionComponent(item.tool, `friendly-native-${index}`, item.args, {}, undefined, { requestRender() {} }, "/tmp/project");
		component.updateResult({ content: [], details: undefined, isError: false });
		const rendered = component.render(160).map(stripTerminalControls).join("\n");
		assert.match(rendered, new RegExp(item.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), item.tool);
		if (item.forbidden) assert.doesNotMatch(rendered, new RegExp(item.forbidden), item.tool);
	}
});

test("Friendly shell labels parse exact commands and compose independent actions", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
	const cases = [
		{ command: "python3 -m pytest", expected: "运行项目测试" },
		{ command: "python3 -m unittest discover -s tests -p 'test_render_results.py' -v", expected: "运行测试：test_render_results.py", forbidden: "运行项目测试" },
		{ command: "node --test tests/pi-riff-reload.test.mjs", expected: "运行测试：tests/pi-riff-reload.test.mjs", forbidden: "运行项目测试" },
		{ command: "npm run test:integration", expected: "运行项目脚本：test:integration", forbidden: "运行测试" },
		{ command: "python3 -m py_compile src/app.py", expected: "检查 Python 语法：src/app.py" },
		{ command: "node --check src/index.js", expected: "检查 JavaScript 语法：src/index.js" },
		{ command: "python3 scripts/rebuild_index.py --dry-run", expected: "运行 Python 脚本：scripts/rebuild_index.py", forbidden: "重建索引" },
		{ command: "API_KEY=secret python3 .scratch/validation/run_integrated_baseline.py --limit 3", expected: "运行 Python 脚本：.scratch/validation/run_integrated_baseline.py", forbidden: "运行集成基线" },
		{ command: "uv run python scripts/render_results.py", expected: "运行 Python 脚本：scripts/render_results.py", forbidden: "生成结果页面" },
		{ command: "node scripts/render-results.mjs --out report.html", expected: "运行 Node.js 脚本：scripts/render-results.mjs", forbidden: "生成" },
		{ command: "./scripts/backfill.py --limit 10", expected: "运行 Python 脚本：scripts/backfill.py", forbidden: "回填数据" },
		{ command: "python3 jobs/custom_worker.py --once", expected: "运行 Python 脚本：jobs/custom_worker.py" },
		{ command: "python3 tools/freeze_us_run_manifest.py freeze --run-id v1", expected: "运行 Python 脚本：tools/freeze_us_run_manifest.py", forbidden: "冻结运行清单" },
		{ command: "python3 tools/freeze_us_run_manifest.py verify receipt.json", expected: "运行 Python 脚本：tools/freeze_us_run_manifest.py", forbidden: "验证运行冻结清单" },
		{ command: "python3 tools/probe_p002.py --plan fixed.json", expected: "运行 Python 脚本：tools/probe_p002.py", forbidden: "探测 P002" },
		{ command: "python3 tools/build_dataset_v1.py", expected: "运行 Python 脚本：tools/build_dataset_v1.py", forbidden: "构建 V1 数据集" },
		{ command: "python3 tools/run_and_seal_us_evaluation.py prepare --run-id v1", expected: "运行 Python 脚本：tools/run_and_seal_us_evaluation.py", forbidden: "准备封存评估" },
		{ command: "python3 tools/run_and_seal_us_evaluation.py verify --run-dir runs/v1", expected: "运行 Python 脚本：tools/run_and_seal_us_evaluation.py", forbidden: "验证封存评估" },
		{ command: "python3 scripts/native_agent_db.py history", expected: "运行 Python 脚本：scripts/native_agent_db.py", forbidden: "数据库历史" },
		{ command: "bash scripts/deploy.sh --dry-run", expected: "运行 Shell 脚本：scripts/deploy.sh" },
		{ command: "bash -n scripts/deploy.sh", expected: "检查 Shell 语法：scripts/deploy.sh", forbidden: "运行 Shell 脚本" },
		{ command: "./scripts/check-receipts.sh", expected: "运行 Shell 脚本：scripts/check-receipts.sh" },
		{ command: "./scripts/tests/test-runtime.sh", expected: "运行 Shell 脚本：scripts/tests/test-runtime.sh", forbidden: "运行测试" },
		{ command: "sudo zsh tools/release.zsh", expected: "运行 Shell 脚本：tools/release.zsh", forbidden: "运行 sudo" },
		{ command: "bash -lc 'echo ready'", expected: "执行 Shell 命令", forbidden: "运行 Shell 脚本" },
		{ command: "ruby -e 'puts 1'", expected: "执行内联 Ruby", forbidden: "运行 ruby" },
		{ command: "ruby scripts/report.rb", expected: "运行 Ruby 脚本：scripts/report.rb" },
		{ command: "perl -0777 -ne 'print' page.html", expected: "执行内联 Perl", forbidden: "运行 perl" },
		{ command: "expect -c 'spawn pi'", expected: "执行内联 Expect", forbidden: "运行 expect" },
		{ command: "uv --directory server run --frozen pytest -q", expected: "运行项目测试", forbidden: "执行 uv" },
		{ command: "uv run ruff check src tests", expected: "检查代码规范" },
		{ command: "uvx --from ruff ruff check src tests", expected: "检查代码规范", forbidden: "运行 uvx" },
		{ command: "$PY -m ruff check src tests", expected: "检查代码规范", forbidden: "运行 Python 模块" },
		{ command: "uv run mypy src", expected: "检查 Python 类型" },
		{ command: "npm run lint", expected: "运行项目脚本：lint", forbidden: "检查代码规范" },
		{ command: "make service-status", expected: "运行 Make 目标：service-status", forbidden: "检查服务状态" },
		{ command: "npm --prefix web exec -- vue-tsc --noEmit", expected: "检查项目类型" },
		{ command: "npx prettier --check src/app.ts", expected: "检查代码格式", forbidden: "运行 npx" },
		{ command: "git add src/app.ts", expected: "暂存 src/app.ts" },
		{ command: "git rebase main", expected: "变基到 main" },
		{ command: "git merge-base --is-ancestor main HEAD", expected: "检查分支祖先关系" },
		{ command: "git blame -L 10,20 -- src/app.ts", expected: "查看代码归属" },
		{ command: "git status --short; git log -2 --oneline; git diff --stat", expected: "检查仓库状态与变更", forbidden: "另 1 项" },
		{ command: "git commit -m 'refine labels' && git push", expected: "提交并推送代码更改" },
		{ command: "git status --short && npm test", expected: "检查仓库状态；运行项目测试" },
		{ command: "cd /tmp/project\nrg -n 'Friendly' src | head -20", expected: "在 src 搜索：Friendly", forbidden: "运行 cd" },
		{ command: "rg -n 'REUSE_PLAN_MISMATCH|_source_plan' src/single_case_executor.py", expected: "在 src/single_case_executor.py 搜索：REUSE_PLAN_MISMATCH|_source_plan" },
		{ command: "rg -n -e 'Node3' -e 'Node4' src/runner.py src/contracts.py", expected: "在 src/runner.py 等 2 处 搜索：Node3｜Node4" },
		{ command: "rg 'alpha' src/a.ts; rg 'beta' src/b.ts", expected: "在 src/a.ts 搜索：alpha；在 src/b.ts 搜索：beta", forbidden: "另" },
		{ command: "grep -R --include='*.py' 'validated_model_checkpoints' src tests", expected: "在 src 等 2 处 搜索：validated_model_checkpoints", forbidden: "--include" },
		{ command: "rg --files src | head -100", expected: "列出项目文件", forbidden: "搜索代码内容" },
		{ command: "find src -name '*.test.ts'", expected: "在 src 查找文件：*.test.ts" },
		{ command: "python3 - <<'PY'\nimport json\nprint(json.load(open('data.json')))\nPY", expected: "执行内联 Python", forbidden: "分析数据" },
		{ command: "python3 - <<'PY'\nimport ast\nast.parse(open('app.py').read())\nPY", expected: "执行内联 Python", forbidden: "分析 Python 代码" },
		{ command: "python3 - <<'PY'\nimport os\nprint(os.getenv('DATABASE_URL'))\nPY", expected: "执行内联 Python", forbidden: "检查环境配置" },
		{ command: "node --input-type=module <<'EOF'\nimport { createAgentSession } from 'pi';\nEOF", expected: "执行内联 Node.js", forbidden: "Pi SDK" },
		{ command: "for f in *.jsonl; do jq -r '.type' \"$f\"; done", expected: "处理 JSON 数据", forbidden: "运行 for" },
		{ command: "set -euo pipefail\ndocker compose ps", expected: "检查容器状态", forbidden: "运行 set" },
		{ command: "cat app.log 2>&1 | tail -20", expected: "查看日志 app.log", forbidden: "读取 2>&1" },
		{ command: "psql app -Atc 'select count(*) from users'", expected: "查询数据库" },
		{ command: "python3 scripts/fto-dotenv-exec.py .env bash -lc 'psql app -Atc select'", expected: "运行 Python 脚本：scripts/fto-dotenv-exec.py", forbidden: "查询数据库" },
		{ command: "python3 scripts/fto-dotenv-exec.py .env python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('app.py'))\nPY", expected: "运行 Python 脚本：scripts/fto-dotenv-exec.py", forbidden: "执行内联 Python" },
		{ command: "python3 - '$file' <<'PY'\nfrom pathlib import Path\nprint(Path('app.py'))\nPY", expected: "执行内联 Python", forbidden: "$file" },
		{ command: "python3 -c \"open('config.py').read()\"", expected: "执行内联 Python", forbidden: "config.py" },
		{ command: "node scripts/wrapper.mjs <<'JS'\nconsole.log('input')\nJS", expected: "运行 Node.js 脚本：scripts/wrapper.mjs", forbidden: "执行内联 Node.js" },
		{ command: "python3 scripts/wrapper.py --flag -m unittest tests/test_nested.py", expected: "运行 Python 脚本：scripts/wrapper.py", forbidden: "运行测试" },
		{ command: "python3 scripts/fto-dotenv-exec.py .env python3 -m unittest tests/test_nested.py", expected: "运行 Python 脚本：scripts/fto-dotenv-exec.py", forbidden: "运行测试" },
		{ command: "playwright-cli -s=pi click '#submit'", expected: "点击网页元素" },
		{ command: "playwright-cli -s=pi run-code 'async page => page.title()'", expected: "在浏览器执行脚本" },
		{ command: "playwright-cli -s=pi eval 'document.body.innerText'", expected: "在浏览器执行脚本", forbidden: "读取网页内容" },
		{ command: "playwright-cli -s=pi eval 'JSON.stringify(localStorage)'", expected: "在浏览器执行脚本", forbidden: "检查浏览器存储" },
		{ command: "playwright-cli -s=pi eval 'getComputedStyle(document.body).display'", expected: "在浏览器执行脚本", forbidden: "检查网页布局" },
		{ command: "./scripts/fto-workflow service-status", expected: "运行可执行脚本：scripts/fto-workflow", forbidden: "检查服务状态" },
		{ command: "command -v playwright-cli", expected: "检查命令可用性：playwright-cli" },
		{ command: "export MODE=test; python3 scripts/run.py", expected: "运行 Python 脚本：scripts/run.py", forbidden: "运行 export" },
		{ command: "pi --version; pi list", expected: "查看 Pi 版本；列出 Pi 扩展", forbidden: "运行 Pi" },
		{ command: "pi --no-extensions --session-dir /tmp/probe -p 'hello'", expected: "运行 Pi 自动化会话" },
		{ command: "echo 'git status'", expected: "输出命令信息", forbidden: "检查仓库状态" },
		{ command: "printf 'rm src/app.ts'", expected: "输出命令信息", forbidden: "删除" },
	];
	for (const [index, item] of cases.entries()) {
		const component = new ToolExecutionComponent("bash", `friendly-shell-${index}`, { command: item.command }, {}, undefined, { requestRender() {} }, "/tmp/project");
		component.updateResult({ content: [], details: undefined, isError: false });
		const rendered = component.render(160).map(stripTerminalControls).join("\n");
		assert.match(rendered, new RegExp(item.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), item.command);
		if (item.forbidden) assert.doesNotMatch(rendered, new RegExp(item.forbidden), item.command);
	}
});

test("Friendly completed file calls show localized result facts", async () => {
	const toolStyle = customPiExtension.commands.get("tool-style");
	await toolStyle.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
	const read = new ToolExecutionComponent("read", "friendly-fact-read", { path: "/tmp/project/src/app.ts" }, {}, undefined, { requestRender() {} }, "/tmp/project");
	read.updateResult({ content: [{ type: "text", text: "a\nb\nc" }], details: undefined, isError: false });
	const completedRead = read.render(100).join("\n");
	assert.match(stripTerminalControls(completedRead), /3 行/);
	assert.ok(completedRead.includes(activeTheme.fg("success", activeTheme.bold("读取"))));
	assert.ok(completedRead.includes(`${activeTheme.getFgAnsi("toolOutput")} src/app.ts`));
	assert.equal(completedRead.includes(activeTheme.fg("success", activeTheme.bold("读取 src/app.ts"))), false);

	const runningRead = new ToolExecutionComponent("read", "friendly-running-read", { path: "/tmp/project/src/running.ts" }, {}, undefined, { requestRender() {} }, "/tmp/project");
	const runningLine = runningRead.render(100).join("\n");
	assert.ok(runningLine.includes(activeTheme.fg("success", activeTheme.bold("读取"))));
	assert.ok(runningLine.includes(`${activeTheme.getFgAnsi("toolTitle")} src/running.ts`));
	assert.equal(runningLine.includes(activeTheme.fg("success", activeTheme.bold("读取 src/running.ts"))), false);
	runningRead.updateResult({ content: [], details: undefined, isError: false });
	runningRead.render(100);

	const search = new ToolExecutionComponent("grep", "friendly-search-style", { path: "/tmp/project/src", pattern: "读取|搜索" }, {}, undefined, { requestRender() {} }, "/tmp/project");
	search.updateResult({ content: [], details: undefined, isError: false });
	const searchLine = search.render(100).join("\n");
	assert.ok(searchLine.includes(activeTheme.fg("success", activeTheme.bold("搜索"))));
	assert.equal(searchLine.includes(activeTheme.fg("success", activeTheme.bold("在 src"))), false);
	assert.equal(searchLine.includes(activeTheme.fg("success", activeTheme.bold("读取|搜索"))), false);

	const write = new ToolExecutionComponent("write", "friendly-fact-write", { path: "/tmp/project/docs/report.md", content: "hello" }, {}, undefined, { requestRender() {} }, "/tmp/project");
	write.updateResult({ content: [], details: undefined, isError: false });
	assert.match(write.render(100).map(stripTerminalControls).join("\n"), /5 字节/);
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

test("Compact and Full match official tool rendering including previews, errors, padding and duration", async () => {
	const command = customPiExtension.commands.get("tool-style");
	const ui = { notify() {}, setToolsExpanded() {} };
	try {
		await command.handler("compact", { ui });
		assert.deepEqual(toolRenderMatrix(false), nativeCompactRendering);
		await command.handler("full", { ui });
		assert.deepEqual(toolRenderMatrix(true), nativeFullRendering);
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			assert.equal(customPiExtension.tools.has(name), false, `Riff must not replace builtin ${name}`);
		}
	} finally {
		await command.handler("friendly", { ui });
	}
});

test("switching Friendly or Command to Compact refreshes already-collapsed tools", async () => {
	const command = customPiExtension.commands.get("tool-style");
	const instance = { toolOutputExpanded: false, chatContainer: new Container(), loadedResourcesContainer: new Container(),
		showStatus() {}, ui: { requestRender() {} } };
	const ui = { notify() {}, setToolsExpanded: (expanded) => interactivePrototype.setToolsExpanded.call(instance, expanded) };
	try {
		for (const mode of ["friendly", "command"]) {
			await command.handler(mode, { ui });
			instance.chatContainer.clear();
			const tool = new ToolExecutionComponent("unknown", "mode-switch", { query: "hello" }, {}, undefined,
				{ requestRender() {} }, repositoryRoot);
			tool.updateResult(switchResult);
			instance.chatContainer.addChild(tool);
			await command.handler("compact", { ui });
			assert.deepEqual(tool.render(80), nativeSwitchLines);
		}
	} finally {
		await command.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
	}
});

test("dense tool mouse clicks use rendered bounds while drag, wheel and pending calls pass through", async () => {
	const command = customPiExtension.commands.get("tool-style");
	const event = { type: "click", button: "left", x: 3, y: 0, screenX: 3, screenY: 0, width: 60, height: 1,
		shift: false, alt: false, ctrl: false };
	try {
		for (const mode of ["command", "friendly"]) {
			await command.handler(mode, { ui: { notify() {}, setToolsExpanded() {} } });
			let redraws = 0;
			const tool = new ToolExecutionComponent("read", "click", { path: "hello.ts" }, {}, undefined,
				{ requestRender() { redraws++; } }, repositoryRoot);
			assert.equal(tool.handleMouse(event), undefined, "pending calls should not expand");
			tool.updateResult(switchResult);
			const lines = tool.render(60);
			for (const type of ["press", "drag", "wheel", "release"]) {
				assert.equal(tool.handleMouse({ ...event, type }), undefined);
			}
			assert.equal(tool.handleMouse({ ...event, y: lines.length }), undefined);
			assert.equal(tool.handleMouse({ ...event, button: "right" }), undefined);
			assert.equal(tool.handleMouse({ ...event, y: lines.length - 1, height: lines.length })?.handled, true);
			assert.equal(tool.expanded, true);
			assert.ok(redraws > 0);
		}
	} finally { await command.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } }); }
});

test("switching to official tool modes stops Riff's dense-tool animation timer", async () => {
	const state = globalThis[Symbol.for("pi.custom-pi.minimal-tool-state")];
	const command = customPiExtension.commands.get("tool-style");
	try {
		for (const mode of ["compact", "full"]) {
			await command.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
			const tool = new ToolExecutionComponent("read", "animation", { path: "pending.ts" }, {}, undefined,
				{ requestRender() {} }, repositoryRoot);
			tool.render(80);
			assert.ok(state.animationTimer !== undefined);
			await command.handler(mode, { ui: { notify() {}, setToolsExpanded() {} } });
			assert.equal(state.animationTimer, undefined);
			assert.equal(state.runningTools.size, 0);
		}
	} finally { await command.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } }); }
});

test("user image caches invalidate with the message on terminal or theme changes", () => {
	const message = new UserMessageComponent("");
	let thumbnailInvalidations = 0;
	let expandedInvalidations = 0;
	message.customPiImages = [{ thumbnail: { invalidate: () => thumbnailInvalidations++ },
		expanded: { invalidate: () => expandedInvalidations++ }, dimensions: { widthPx: 1, heightPx: 1 } }];
	message.invalidate();
	assert.equal(thumbnailInvalidations, 1);
	assert.equal(expandedInvalidations, 1);
});

test("dense highlights follow the current dark or light theme instead of fixed RGB colors", async () => {
	const state = footerTimerState;
	const previous = state.getTheme;
	const command = customPiExtension.commands.get("tool-style");
	try {
		await command.handler("command", { ui: { notify() {}, setToolsExpanded() {} } });
		state.getTheme = () => themeExports.theme;
		const tool = new ToolExecutionComponent("read", "theme", { path: "hello.ts" }, {}, undefined,
			{ requestRender() {} }, repositoryRoot);
		tool.updateResult(switchResult);
		let dark;
		for (const name of ["dark", "light"]) {
			initTheme(name);
			const current = themeExports.theme;
			const line = tool.render(80)[0];
			assert.ok(line.includes(current.fg("success", current.bold("hello.ts"))));
			const entry = customPiExtension.entryRenderers.get("compact-agent-timing")({ data: { round: 1, durationMs: 1000 } }, {}, current);
			assert.ok(entry.render(80)[0].includes(current.fg("accent", current.bold("第 1 轮"))));
			if (name === "dark") dark = line;
			else assert.notEqual(line, dark);
		}
	} finally {
		initTheme("dark"); state.getTheme = previous;
		await command.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } });
	}
});

test("image-only message preserves native Kitty row allocation and invalidates on cell-size changes", () => {
	const caps = getCapabilities();
	const cells = getCellDimensions();
	const state = globalThis[Symbol.for("pi.custom-pi.user-message-time")];
	const previousExpanded = state.imagesExpanded;
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
	try {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 9, heightPx: 18 });
		state.imagesExpanded = false;
		const dimensions = { widthPx: 512, heightPx: 512 };
		const thumbnail = new Image(png, "image/png", { fallbackColor: (text) => text }, { maxHeightCells: 16 }, dimensions);
		const expanded = new Image(png, "image/png", { fallbackColor: (text) => text }, { maxHeightCells: 40 }, dimensions);
		const message = new UserMessageComponent("");
		message.customPiImages = [{ thumbnail, expanded, dimensions }];
		const initial = message.render(40);
		assert.ok(initial.some((line) => line.includes("\x1b_G")));
		assert.equal(initial.length, thumbnail.render(38).length + 3);
		const id = thumbnail.getImageId();
		setCellDimensions({ widthPx: 9, heightPx: 36 });
		message.invalidate();
		const resized = message.render(40);
		assert.ok(resized.length < initial.length);
		assert.equal(thumbnail.getImageId(), id);
		message.setExpanded(true);
		assert.equal(message.render(40).length, expanded.render(38).length + 3);
		assert.ok(message.render(12).length > 0);
	} finally { setCapabilities(caps); setCellDimensions(cells); state.imagesExpanded = previousExpanded; }
});

test("reloading current Riff does not stack prototype wrappers or replace builtin tools", async () => {
	const before = { toolRender: ToolExecutionComponent.prototype.render, toolMouse: ToolExecutionComponent.prototype.handleMouse,
		footerRender: FooterComponent.prototype.render, userInvalidate: UserMessageComponent.prototype.invalidate,
		setToolsExpanded: InteractiveMode.prototype.setToolsExpanded };
	const reloaded = await loadExtensions([extensionPath], repositoryRoot);
	assert.deepEqual(reloaded.errors, []);
	const extension = reloaded.extensions.find((candidate) => candidate.resolvedPath === extensionPath);
	assert.ok(extension);
	assert.deepEqual({ toolRender: ToolExecutionComponent.prototype.render, toolMouse: ToolExecutionComponent.prototype.handleMouse,
		footerRender: FooterComponent.prototype.render, userInvalidate: UserMessageComponent.prototype.invalidate,
		setToolsExpanded: InteractiveMode.prototype.setToolsExpanded }, before);
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) assert.equal(extension.tools.has(name), false);
	const command = extension.commands.get("tool-style");
	try {
		await command.handler("compact", { ui: { notify() {}, setToolsExpanded() {} } });
		assert.deepEqual(toolRenderMatrix(false), nativeCompactRendering);
		const f = footerFixture([{ type: "usage", usage: sampleUsage() }]);
		for (let i = 0; i < 5; i++) f.footer.render(180);
		assert.equal(f.scans(), 1);
	} finally { await command.handler("friendly", { ui: { notify() {}, setToolsExpanded() {} } }); }
});

test("user message right padding keeps its background after a nested background reset", () => {
	const state = globalThis[Symbol.for("pi.custom-pi.user-message-time")];
	state.getTheme = () => activeTheme;
	// The old Box -> Markdown layout ends its content with SGR 49.
	const content = activeTheme.bg("userMessageBg", "还有 gpt-6-sol 系列");
	const message = { children: [{ children: [{ render: () => [content] }] }] };
	const line = state.renderRightBubble(message, 60)[1];
	let background = false;
	let lastSpaceBackground;
	for (const token of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b])/gu)) {
		if (token[1] !== undefined) {
			if (token[1].startsWith("48;")) background = true;
			else if (token[1] === "49" || token[1] === "0" || token[1] === "") background = false;
		} else if (token[2] === " ") lastSpaceBackground = background;
	}
	assert.equal(lastSpaceBackground, true, "rightmost padding cell must retain userMessageBg");
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

test("native user Markdown supports outputPad, resize, and wide text without overflow", () => {
	const state = globalThis[Symbol.for("pi.custom-pi.user-message-time")];
	state.getTheme = () => activeTheme;
	const message = new UserMessageComponent("还有 gpt-6-sol 系列 **粗体** `code`\n\n第二行");
	for (const padding of [0, 1, 3]) {
		message.setOutputPad(padding);
		for (const width of [8, 20, 60]) {
			const lines = message.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.equal(visibleWidth(lines[0]), width);
			assert.ok(stripTerminalControls(lines[1]).startsWith(" ".repeat(padding)));
		}
	}
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
