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
const { loadExtensions } = await import(loaderUrl.href);
const { FooterComponent, InteractiveMode, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent, parseSkillBlock } = await import(indexUrl.href);
const { initTheme } = await import(themeUrl.href);
initTheme("dark");

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

const loaded = await loadExtensions([extensionPath], repositoryRoot);
assert.deepEqual(loaded.errors, []);
const customPiExtension = loaded.extensions.find((extension) => extension.resolvedPath === extensionPath);
assert.ok(customPiExtension);
assert.equal(footerPrototype.compactCtxTitleStatusLinePatched, true);

const stripTerminalControls = (line) => line
	.replace(/\x1b\]133;[ABC]\x07/g, "")
	.replace(/\x1b\[[0-9;]*m/g, "");

test("context title writes stay behind the agent tool", async () => {
	const command = customPiExtension.commands.get("ctx-title");
	const tool = customPiExtension.tools.get("set_ctx_title");
	assert.ok(command);
	assert.ok(tool);
	assert.equal(customPiExtension.commands.has("workspace-context"), false);
	assert.equal(customPiExtension.tools.has("set_workspace_context"), false);
	assert.equal("title" in tool.definition.parameters.properties, true);
	assert.equal("intent" in tool.definition.parameters.properties, false);
	assert.equal((tool.definition.parameters.required ?? []).includes("intent"), false);
	assert.equal("status" in tool.definition.parameters.properties, false);
	assert.equal(command.description, "Show or clear the stable parent context title and session display name");
	assert.match(tool.definition.description, /active project's instructions/);

	const notifications = [];
	const ctx = { ui: { notify: (message, level) => notifications.push({ message, level }) } };
	await command.handler("", ctx);
	await command.handler("update", ctx);
	await command.handler("wt:manual override", ctx);

	assert.deepEqual(notifications, [
		{ message: "Context title: unset", level: "info" },
		{ message: "Usage: /ctx-title [clear]", level: "error" },
		{ message: "Usage: /ctx-title [clear]", level: "error" },
	]);
});

test("Friendly labels have no model configuration or sidecar runtime", () => {
	assert.equal(customPiExtension.tools.has("set_riff_summary_model"), false);
	assert.equal(customPiExtension.commands.has("riff-model"), false);
	const source = readFileSync(extensionPath, "utf8");
	assert.doesNotMatch(source, /completeSimple/);
	assert.doesNotMatch(source, /pi-riff-tool-summary/);
	assert.doesNotMatch(source, /summaryModel/);
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
	assert.equal(commandLine.length, 72);
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

test("user messages reserve one blank row after the timestamp", () => {
	const message = new UserMessageComponent("spacing test");
	message.customPiTimestamp = new Date(2026, 6, 20, 10, 34).getTime();

	const lines = message.render(80);

	assert.equal(lines.at(-1), " ".repeat(80));
	assert.equal(stripTerminalControls(lines.at(-2)).trim(), "2026.7.20 10:34");
});

test("user message bubbles can use ninety percent of the available width", () => {
	const message = new UserMessageComponent("x".repeat(200));
	message.customPiTimestamp = new Date(2026, 6, 20, 10, 34).getTime();

	const lines = message.render(100);
	const timestampLine = stripTerminalControls(lines.at(-2));

	assert.equal(timestampLine.indexOf("2026.7.20 10:34"), 10);
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
