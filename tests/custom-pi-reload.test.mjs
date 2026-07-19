import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extensionPath = join(repositoryRoot, "extensions", "custom-pi.ts");
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
const { loadExtensions } = await import(loaderUrl.href);
const { InteractiveMode, UserMessageComponent } = await import(indexUrl.href);

let legacyBindings = 0;
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
	const component = new UserMessageComponent(text);
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
