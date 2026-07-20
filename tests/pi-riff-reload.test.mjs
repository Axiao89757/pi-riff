import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(repositoryRoot, "extensions", "pi-riff.ts");
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
	assert.equal("intent" in tool.definition.parameters.properties, true);
	assert.equal((tool.definition.parameters.required ?? []).includes("intent"), true);
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

test("Friendly tool summaries are display-only and all four modes are selectable", async () => {
	const toolCallHandlers = customPiExtension.handlers.get("tool_call") ?? [];
	assert.equal(toolCallHandlers.length, 1);
	const toolCall = {
		type: "tool_call",
		toolName: "probe",
		toolCallId: "probe-call",
		input: { query: "raw query", intent: "检查后台会话状态" },
	};
	for (const handler of toolCallHandlers) await handler(toolCall, {});
	assert.deepEqual(toolCall.input, { query: "raw query" });

	const contextHandlers = customPiExtension.handlers.get("context") ?? [];
	assert.equal(contextHandlers.length, 1);
	const originalArguments = { query: "raw query", intent: "检查后台会话状态" };
	const contextEvent = {
		type: "context",
		messages: [{ role: "assistant", content: [{ type: "toolCall", id: "probe-call", name: "probe", arguments: originalArguments }] }],
	};
	const contextResult = await contextHandlers[0](contextEvent, {});
	assert.deepEqual(contextResult.messages[0].content[0].arguments, { query: "raw query" });
	assert.equal(originalArguments.intent, "检查后台会话状态");

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
		"probe",
		"probe-call",
		{ query: "raw query", intent: "检查后台会话状态" },
		{},
		undefined,
		{ requestRender() {} },
		repositoryRoot,
	);
	component.updateResult({ content: [], details: undefined, isError: false });
	const friendlyLines = component.render(100).map(stripTerminalControls);
	assert.equal(friendlyLines.some((line) => line.includes("检查后台会话状态")), true);
	assert.equal(friendlyLines.some((line) => line.includes("raw query")), false);

	component.updateResult({
		content: [{ type: "text", text: "probe failed" }],
		details: undefined,
		isError: true,
	});
	const failedLines = component.render(100).map(stripTerminalControls);
	assert.equal(failedLines.some((line) => line.includes("检查后台会话状态")), true);
	assert.equal(failedLines.some((line) => line.includes("probe failed")), true);

	await toolStyle.handler("command", ctx);
	const commandLines = component.render(100).map(stripTerminalControls);
	assert.equal(commandLines.some((line) => line.includes("raw query")), true);
	assert.equal(commandLines.some((line) => line.includes("检查后台会话状态")), false);

	await toolStyle.handler("full", ctx);
	component.setExpanded(true);
	const fullLines = component.render(100).map(stripTerminalControls);
	assert.equal(fullLines.some((line) => line.includes("intent")), false);
	assert.equal(expandedStates.at(-1), true);
	assert.deepEqual(notifications.map((entry) => entry.message), [
		"Tool display mode: friendly",
		"Tool display mode: command",
		"Tool display mode: full",
	]);
	await toolStyle.handler("friendly", ctx);
});

test("missing tool intent falls back directly to Command rendering", async () => {
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "核对发布后的仓库状态" },
			{ type: "toolCall", id: "missing-intent", name: "bash", arguments: { command: "git status" } },
		],
	};
	for (const handler of customPiExtension.handlers.get("message_update") ?? []) {
		await handler({ type: "message_update", message }, {});
	}
	assert.equal(message.content[1].arguments.intent, "");

	const component = new ToolExecutionComponent(
		"bash",
		"missing-intent",
		message.content[1].arguments,
		{},
		undefined,
		{ requestRender() {} },
		repositoryRoot,
	);
	component.updateResult({ content: [], details: undefined, isError: false });
	const lines = component.render(100).map(stripTerminalControls);
	assert.equal(lines.some((line) => line.includes("git status")), true);
	assert.equal(lines.some((line) => line.includes("核对发布后的仓库状态")), false);
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
