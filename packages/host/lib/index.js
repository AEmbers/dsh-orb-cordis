import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { accessibilityTrusted, promptAccessibility, selectionRuntimeAvailable, startSelectionMonitor } from "@dsh-orb/native-selection";
import { fileURLToPath } from "node:url";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createServer } from "node:net";
import { pipeline } from "node:stream/promises";
//#region src/tcc.ts
/**
* Screen Recording and Accessibility status for the process that actually calls screencapture and osascript.
* The desktop host is the DeepSeek Harness executable. `dsh web` is the terminal's node process.
*/
const SETTINGS_URL = {
	screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
};
/** Remembers which panes were opened so a grant that needs a relaunch is visible. */
var TccMonitor = class {
	opened = /* @__PURE__ */ new Set();
	probe;
	probeFailed = false;
	status() {
		const appName = tccAppName();
		if (process.platform !== "darwin") return {
			applicable: false,
			appName,
			screen: "granted",
			accessibility: "granted"
		};
		const probe = this.loadProbe();
		return {
			applicable: true,
			appName,
			screen: this.right("screen", probe?.screen() ?? false),
			accessibility: this.right("accessibility", probe?.accessibility() ?? false)
		};
	}
	async open(right) {
		if (process.platform !== "darwin") return;
		this.opened.add(right);
		await openExternal(SETTINGS_URL[right]);
	}
	right(right, granted) {
		if (granted) return "granted";
		return this.opened.has(right) ? "needsRelaunch" : "missing";
	}
	loadProbe() {
		if (this.probe) return this.probe;
		if (this.probeFailed) return void 0;
		try {
			this.probe = loadMacProbe();
			return this.probe;
		} catch (error) {
			this.probeFailed = true;
			console.error(`dsh-orb: TCC probe unavailable: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	}
};
function isDesktopHost() {
	if (typeof process.env.DSH_DESKTOP_NODE_EXECUTABLE === "string" && process.env.DSH_DESKTOP_NODE_EXECUTABLE !== "") return true;
	return process.execPath.includes("DeepSeek Harness");
}
function tccAppName() {
	if (isDesktopHost()) return "DeepSeek Harness";
	return `${process.env.LANG ?? ""}${process.env.LC_ALL ?? ""}`.toLowerCase().includes("zh") ? "终端" : "Terminal";
}
function isTccRight(value) {
	return value === "screen" || value === "accessibility";
}
function loadMacProbe() {
	const library = createRequire(import.meta.url)("koffi").load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
	const screen = library.func("bool CGPreflightScreenCaptureAccess()");
	const accessibility = library.func("bool AXIsProcessTrusted()");
	return {
		screen: () => screen() === true,
		accessibility: () => accessibility() === true
	};
}
function openExternal(url) {
	const command = process.platform === "win32" ? "cmd" : "open";
	const args = process.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url];
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			windowsHide: true
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`open exited ${code ?? "unknown"}`));
		});
	});
}
//#endregion
//#region src/preferences.ts
/**
* Profile files the ball and the settings page share.
* Names match the desktop fork so an existing profile keeps its choices.
*/
const PERMISSION_FILE = "orb-permission.json";
const MODELS_FILE = "orb-agent-models.json";
const MILLIFRACTION_FILE = "millifraction-coordinates.json";
const SELECTION_FILE = "selection-toolbar.json";
const BALL_FILE = "ball-enabled.json";
const AVATAR_FILE = "orb-avatar";
const AVATAR_META_FILE = "orb-avatar.json";
const PERMISSION_PRESETS = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
const DEFAULT_MODEL = {
	provider: "deepseek-official",
	model: "deepseek-flash",
	reasoningEffort: "max"
};
/**
* Active official profile directory.
* Desktop and `dsh web` both provide `profileContext.dir`. The process directory is the fallback.
*/
function profileDirectory(ctx) {
	const profile = ctx.get("profileContext");
	if (typeof profile === "object" && profile !== null && "dir" in profile) {
		const dir = profile.dir;
		if (typeof dir === "string" && dir !== "") return dir;
	}
	return process.cwd();
}
function isPermissionPreset(value) {
	return typeof value === "string" && PERMISSION_PRESETS.includes(value);
}
function isAgentModelSelection(value) {
	return parseSelection(value) !== void 0;
}
/** In-memory view of the profile files. Writes update the cache and the disk together. */
var ProfileStore = class {
	dir;
	permissionValue;
	permissionFallbackValue;
	modelValue;
	millifractionValue;
	selectionValue;
	selectionLanguage;
	ballValue;
	constructor(dir) {
		this.dir = dir;
		const permission = readPermission(dir);
		this.permissionValue = permission.preset;
		this.permissionFallbackValue = permission.fallback;
		this.modelValue = readModels(dir);
		this.millifractionValue = readMillifraction(dir);
		const selection = readSelection(dir);
		this.selectionValue = selection.enabled;
		this.selectionLanguage = selection.language;
		this.ballValue = readBall(dir);
	}
	permission() {
		return this.permissionValue;
	}
	/** True when the permission file exists but cannot be used. Missing means full access. */
	permissionFallback() {
		return this.permissionFallbackValue;
	}
	setPermission(preset) {
		this.permissionValue = preset;
		this.permissionFallbackValue = false;
		writeJson(join(this.dir, PERMISSION_FILE), { preset });
	}
	models() {
		return this.modelValue;
	}
	setOverlay(selection) {
		this.modelValue = {
			overlay: selection,
			background: this.modelValue.background
		};
		this.writeModels();
	}
	setBackground(selection) {
		this.modelValue = {
			overlay: this.modelValue.overlay,
			background: selection
		};
		this.writeModels();
	}
	millifractionEnabled() {
		return this.millifractionValue;
	}
	setMillifractionEnabled(enabled) {
		this.millifractionValue = enabled;
		writeJson(join(this.dir, MILLIFRACTION_FILE), { enabled });
	}
	/** Pixel on macOS, millifraction on Windows, unless the profile file says otherwise. */
	coordinateMode() {
		return this.millifractionValue ? "millifraction" : "pixel";
	}
	selectionEnabled() {
		return this.selectionValue;
	}
	translateLanguage() {
		return this.selectionLanguage;
	}
	setTranslateLanguage(language) {
		this.selectionLanguage = language;
		writeJson(join(this.dir, SELECTION_FILE), {
			enabled: this.selectionValue,
			translateTargetLanguage: language
		});
	}
	setSelectionEnabled(enabled) {
		this.selectionValue = enabled;
		writeJson(join(this.dir, SELECTION_FILE), {
			enabled,
			translateTargetLanguage: this.selectionLanguage
		});
	}
	/** Missing file means the ball is on. `autoStart: false` is a separate patch switch. */
	ballEnabled() {
		return this.ballValue;
	}
	setBallEnabled(enabled) {
		this.ballValue = enabled;
		writeJson(join(this.dir, BALL_FILE), { enabled });
	}
	avatarVersion() {
		try {
			return statSync(join(this.dir, AVATAR_FILE)).mtimeMs;
		} catch {
			return 0;
		}
	}
	readAvatar() {
		let bytes;
		try {
			bytes = readFileSync(join(this.dir, AVATAR_FILE));
		} catch {
			return;
		}
		const sniffed = sniffAvatarMime(bytes);
		if (sniffed === void 0) return void 0;
		const declared = readAvatarMime(this.dir);
		if (declared !== void 0 && declared !== sniffed) return void 0;
		return {
			bytes,
			mime: declared ?? sniffed
		};
	}
	writeAvatar(bytes, mime) {
		writeBytes(join(this.dir, AVATAR_FILE), bytes);
		writeJson(join(this.dir, AVATAR_META_FILE), { mime });
	}
	restoreAvatar() {
		for (const name of [AVATAR_FILE, AVATAR_META_FILE]) try {
			unlinkSync(join(this.dir, name));
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	writeModels() {
		writeJson(join(this.dir, MODELS_FILE), {
			overlay: serializeSelection(this.modelValue.overlay),
			background: serializeSelection(this.modelValue.background)
		});
	}
};
function sniffAvatarMime(bytes) {
	if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56 && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97) return "image/gif";
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image/png";
	if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
}
function defaultMillifraction(platform = process.platform) {
	return platform === "win32";
}
function readPermission(dir) {
	let raw;
	try {
		raw = readFileSync(join(dir, PERMISSION_FILE), "utf8");
	} catch (error) {
		if (isEnoent(error)) return {
			preset: "danger-full-access",
			fallback: false
		};
		return {
			preset: "workspace-write",
			fallback: true
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			preset: "workspace-write",
			fallback: true
		};
	}
	const preset = record(parsed)?.preset;
	if (isPermissionPreset(preset)) return {
		preset,
		fallback: false
	};
	return {
		preset: "workspace-write",
		fallback: true
	};
}
function readModels(dir) {
	const value = record(readJson$1(join(dir, MODELS_FILE)));
	return {
		overlay: parseSelection(value?.overlay) ?? DEFAULT_MODEL,
		background: parseSelection(value?.background) ?? DEFAULT_MODEL
	};
}
function readMillifraction(dir) {
	const enabled = record(readJson$1(join(dir, MILLIFRACTION_FILE)))?.enabled;
	return typeof enabled === "boolean" ? enabled : defaultMillifraction();
}
function readSelection(dir) {
	return {
		enabled: false,
		language: record(readJson$1(join(dir, SELECTION_FILE)))?.translateTargetLanguage === "en" ? "en" : "zh"
	};
}
function readBall(dir) {
	const enabled = record(readJson$1(join(dir, BALL_FILE)))?.enabled;
	return typeof enabled === "boolean" ? enabled : true;
}
function readAvatarMime(dir) {
	const mime = record(readJson$1(join(dir, AVATAR_META_FILE)))?.mime;
	if (mime === "image/gif" || mime === "image/png" || mime === "image/webp") return mime;
}
function parseSelection(value) {
	const item = record(value);
	if (item === void 0) return void 0;
	if (typeof item.provider !== "string" || item.provider === "" || item.provider.length > 200) return void 0;
	if (typeof item.model !== "string" || item.model === "" || item.model.length > 200) return void 0;
	if (item.reasoningEffort !== void 0 && (typeof item.reasoningEffort !== "string" || item.reasoningEffort === "" || item.reasoningEffort.length > 80)) return;
	return {
		provider: item.provider,
		model: item.model,
		...typeof item.reasoningEffort === "string" ? { reasoningEffort: item.reasoningEffort } : {}
	};
}
function serializeSelection(selection) {
	return {
		provider: selection.provider,
		model: selection.model,
		...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
	};
}
function readJson$1(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return;
	}
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function writeJson(file, value) {
	writeBytes(file, Buffer.from(`${JSON.stringify(value, void 0, 2)}\n`));
}
function writeBytes(file, bytes) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, bytes);
	renameSync(tmp, file);
}
function isEnoent(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//#endregion
//#region src/catalog.ts
/** Accept the official `modelCatalog()` object, or an empty catalog when it is missing. */
function normalizeCatalog(value) {
	const groups = asRecord$2(value)?.groups;
	if (!Array.isArray(groups)) return { groups: [] };
	const normalized = [];
	for (const group of groups) {
		const record = asRecord$2(group);
		if (record === void 0 || typeof record.id !== "string" || typeof record.name !== "string") continue;
		if (!Array.isArray(record.models)) continue;
		const models = [];
		for (const model of record.models) {
			const item = asRecord$2(model);
			if (item === void 0 || typeof item.id !== "string" || typeof item.name !== "string") continue;
			const reasoning = reasoningOf(item.reasoning);
			models.push({
				id: item.id,
				name: item.name,
				...reasoning === void 0 ? {} : { reasoning }
			});
		}
		if (models.length > 0) normalized.push({
			id: record.id,
			name: record.name,
			models
		});
	}
	return { groups: normalized };
}
function reasoningOf(value) {
	const record = asRecord$2(value);
	if (record === void 0 || !Array.isArray(record.efforts)) return void 0;
	const efforts = [];
	for (const effort of record.efforts) {
		const item = asRecord$2(effort);
		if (item === void 0 || typeof item.id !== "string" || typeof item.name !== "string") continue;
		efforts.push({
			id: item.id,
			name: item.name
		});
	}
	if (efforts.length === 0) return void 0;
	const defaultEffort = typeof record.defaultEffort === "string" && record.defaultEffort !== "" ? record.defaultEffort : void 0;
	return {
		efforts,
		...defaultEffort === void 0 ? {} : { defaultEffort }
	};
}
function asRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
//#endregion
//#region src/helper-path.ts
/**
* Where the helper's files are.
* Installed `dsh-orb` keeps them next to this file: `dist/host/index.js` and `dist/helper/lib/main.js`.
* In the workspace the helper is a separate package that Node resolves by name.
*/
const require = createRequire(import.meta.url);
/** Root folder of the helper: holds `lib/`, `assets/` and the preload scripts. */
function helperRoot() {
	const assembled = fileURLToPath(new URL("../helper", import.meta.url));
	if (existsSync(join(assembled, "lib", "main.js"))) return assembled;
	return dirname(require.resolve("@dsh-orb/helper/package.json"));
}
/** Electron entry script of the helper. */
function helperMain() {
	return join(helperRoot(), "lib", "main.js");
}
/** Bundled default avatar. */
function defaultAvatarPath() {
	return join(helperRoot(), "assets", "deepseek-avatar-square.gif");
}
//#endregion
//#region src/routes.ts
/**
* Settings routes on the official web port.
* The main window calls these with a relative fetch, so the existing login cookie is enough.
* The helper may read only the avatar, and only with its socket token.
*/
const PREFIX = "/.dsh-orb";
const HELPER_HEADER = "x-dsh-orb-helper";
/** Mount `/.dsh-orb` and return the disposer. */
function registerOrbRoutes(deps) {
	return deps.ctx.webServer.register({
		kind: "prefix",
		path: PREFIX,
		handler: (req, res) => handle(deps, req, res)
	});
}
function orbSupported(platform = process.platform) {
	return platform === "darwin" || platform === "win32";
}
async function handle(deps, req, res) {
	const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
	if (!(path === `${PREFIX}/avatar` && req.method === "GET" && helperTokenOk(deps, req))) {
		const rejection = rejectionStatus(deps.ctx, req);
		if (rejection !== void 0) {
			res.writeHead(rejection);
			res.end();
			return;
		}
	}
	const method = req.method ?? "GET";
	if (method === "GET" && path === `${PREFIX}/settings`) {
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/models`) {
		sendJson(res, 200, await catalog(deps));
		return;
	}
	if (method === "GET" && path === `${PREFIX}/tcc`) {
		sendJson(res, 200, deps.tcc.status());
		return;
	}
	if ((method === "GET" || method === "HEAD") && path === `${PREFIX}/avatar`) {
		await sendAvatar(deps.store, method, res);
		return;
	}
	if (!orbSupported()) {
		sendJson(res, 403, { error: "unsupported" });
		return;
	}
	if (method === "POST" && path === `${PREFIX}/overlay-model`) {
		const selection = selectionFrom(await readJson(req));
		if (selection === void 0) {
			sendJson(res, 400, { error: "invalid-model" });
			return;
		}
		await deps.control.setOverlayModel(selection);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/background-model`) {
		const selection = selectionFrom(await readJson(req));
		if (selection === void 0) {
			sendJson(res, 400, { error: "invalid-model" });
			return;
		}
		await deps.control.setBackgroundModel(selection);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/selection`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-selection" });
			return;
		}
		await deps.control.setSelectionEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/millifraction`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-millifraction" });
			return;
		}
		await deps.control.setMillifractionEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/ball`) {
		const enabled = booleanField(await readJson(req));
		if (enabled === void 0) {
			sendJson(res, 400, { error: "invalid-ball" });
			return;
		}
		await deps.control.setBallEnabled(enabled);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/avatar`) {
		const bytes = await readBody(req, 2097153).catch((error) => {
			if (error instanceof Error && error.message === "too-large") return void 0;
			throw error;
		});
		if (bytes === void 0 || bytes.length > 2097152) {
			sendJson(res, 413, { error: "too-large" });
			return;
		}
		const mime = sniffAvatarMime(bytes);
		if (mime === void 0) {
			sendJson(res, 400, { error: "invalid-type" });
			return;
		}
		deps.store.writeAvatar(bytes, mime);
		await deps.control.publishChrome();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/avatar/restore`) {
		deps.store.restoreAvatar();
		await deps.control.publishChrome();
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	if (method === "POST" && path === `${PREFIX}/tcc`) {
		const right = asRecord$1(await readJson(req))?.right;
		if (!isTccRight(right)) {
			sendJson(res, 400, { error: "invalid-tcc" });
			return;
		}
		await deps.tcc.open(right);
		sendJson(res, 200, await snapshot(deps));
		return;
	}
	res.writeHead(404);
	res.end();
}
async function snapshot(deps) {
	const models = deps.store.models();
	const version = Math.trunc(deps.store.avatarVersion());
	return {
		supported: orbSupported(),
		ballEnabled: deps.store.ballEnabled(),
		avatarUrl: `${PREFIX}/avatar?v=${version}`,
		overlay: models.overlay,
		background: models.background,
		selectionEnabled: deps.store.selectionEnabled(),
		millifractionEnabled: deps.store.millifractionEnabled(),
		tcc: deps.tcc.status(),
		helperError: deps.control.helperStatus?.() ?? "",
		selectionAvailable: selectionRuntimeAvailable(),
		permissionFallback: deps.store.permissionFallback()
	};
}
async function catalog(deps) {
	try {
		return normalizeCatalog(await deps.ctx.sessionController.modelCatalog());
	} catch (error) {
		console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`);
		return { groups: [] };
	}
}
async function sendAvatar(store, method, res) {
	const custom = store.readAvatar();
	const mime = custom?.mime ?? "image/gif";
	let body;
	if (custom) body = custom.bytes;
	else try {
		body = await readFile(defaultAvatarPath());
	} catch {
		res.writeHead(404);
		res.end();
		return;
	}
	res.writeHead(200, {
		"content-type": mime,
		"cache-control": "no-store",
		"content-length": body.length
	});
	res.end(method === "HEAD" ? void 0 : body);
}
function helperTokenOk(deps, req) {
	const header = req.headers[HELPER_HEADER];
	return typeof header === "string" && deps.control.helperAuthorized(header);
}
function tokensMatch(given, expected) {
	const left = Buffer.from(given);
	const right = Buffer.from(expected);
	return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
function rejectionStatus(ctx, req) {
	if (typeof ctx.connection.admit === "function") {
		const admitted = ctx.connection.admit(req);
		if (typeof admitted === "object" && admitted !== null && "rejection" in admitted && typeof admitted.rejection === "number") return admitted.rejection;
		return;
	}
	if (typeof ctx.connection.isAuthenticated === "function") return ctx.connection.isAuthenticated(req) ? void 0 : 401;
	return 401;
}
function selectionFrom(value) {
	return isAgentModelSelection(value) ? value : void 0;
}
function booleanField(value) {
	const enabled = asRecord$1(value)?.enabled;
	return typeof enabled === "boolean" ? enabled : void 0;
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
async function readJson(req) {
	const bytes = await readBody(req, 65536);
	if (bytes.length === 0) return void 0;
	return JSON.parse(bytes.toString("utf8"));
}
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(/* @__PURE__ */ new Error("too-large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
function asRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
//#endregion
//#region src/services.ts
/**
* Optional services Computer Use already looks up, plus the Access preset pinned on orb sessions.
*/
/**
* Publish the two model/coordinate services for the life of the plugin.
* @param ctx - host context. `provide` is called once.
* @param store - profile preferences.
*/
function installOrbServices(ctx, store) {
	ctx.provide("orbCodeAgentModel", { currentSelection: () => store.models().background });
	ctx.provide("orbCoordinateMode", { currentMode: () => store.coordinateMode() });
}
/**
* Pin the stored Access preset on Computer Use and background sessions under `dsh_orb`.
* @returns a disposer for the create listener.
*/
function watchOrbPermissions(ctx, store) {
	const dispose = ctx.on("session/created", (session) => {
		pinSession(ctx, session, store.permission());
	});
	return typeof dispose === "function" ? dispose : () => {};
}
/** Pin one already-open session when the chip or a reopen asks for it. */
function pinSessionId(ctx, sessionId, preset) {
	const session = ctx.get("sessions")?.get?.(sessionId);
	if (session) pinSession(ctx, session, preset);
}
function pinSession(ctx, session, preset) {
	if (!isOrbSession(session)) return;
	const presets = ctx.get("permissionPresets");
	if (typeof presets?.set !== "function") return;
	if (!isPermissionPreset(preset)) return;
	try {
		presets.set(session, preset);
	} catch (error) {
		console.error(`dsh-orb: permission preset failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function isOrbSession(session) {
	const preset = session.header?.agentPreset;
	const cwd = session.header?.cwd;
	if (preset !== "computer-use" && preset !== "standard" || cwd === void 0) return false;
	return isOrbWorkspace(cwd, dshHomePath("dsh_orb"));
}
function isOrbWorkspace(cwd, orbCwd) {
	const resolved = resolve(cwd);
	const orb = resolve(orbCwd);
	if (resolved === orb) return true;
	const rel = relative(orb, resolved);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
//#endregion
//#region src/appearance.ts
function describeSettings(settings) {
	const describe = settings?.describe;
	if (typeof describe !== "function") return [];
	try {
		const rows = describe.call(settings);
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}
/** Read the stored theme and locale preferences; unusable sections stay absent. */
function readAppearance(settings) {
	const appearance = {};
	for (const row of describeSettings(settings)) {
		if (row?.ns === "ui-theme") {
			const preference = row.value?.preference;
			if (preference === "light" || preference === "dark" || preference === "system") appearance.theme = preference;
		}
		if (row?.ns === "locale" && typeof row.value?.preference === "string") {
			const preference = row.value.preference;
			if (preference.length > 0 && preference.length <= 35) appearance.locale = preference;
		}
	}
	return appearance;
}
function sameAppearance(left, right) {
	return left.theme === right.theme && left.locale === right.locale;
}
/**
* Follow the live settings document: read once, then re-read whenever the
* theme or locale namespace changes. `settings/document-updated` fires for
* every namespace and describe() itself emits it, so the read is guarded
* against re-entry.
*/
function watchAppearance(ctx, onChange) {
	const settings = ctx.get("settings");
	if (typeof settings?.describe !== "function") return () => {};
	let reading = false;
	const read = () => {
		if (reading) return {};
		reading = true;
		try {
			return readAppearance(settings);
		} finally {
			reading = false;
		}
	};
	let current = read();
	onChange({ ...current });
	const detach = ctx.on("settings/document-updated", (ns) => {
		if (ns !== "ui-theme" && ns !== "locale") return;
		const next = read();
		if (sameAppearance(next, current)) return;
		current = next;
		onChange({ ...current });
	});
	return typeof detach === "function" ? detach : () => {};
}
//#endregion
//#region src/electron-runtime.ts
/**
* Locate the generic Electron binary used to open the ball.
* Official DeepSeek Harness is not a usable helper runtime: it has its own app payload and a single-instance lock.
*/
/** Matches the official app's Electron framework and the fork's desktop package. */
const ELECTRON_VERSION = "44.0.0";
const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
/** Official SHASUMS256.txt for Electron 44.0.0. The download is rejected when it disagrees. */
const PINNED_SHA256 = {
	"electron-v44.0.0-darwin-arm64.zip": "076d79742986e1b100b69ebecc691cb07368045e54c9087cef631b8622b76a80",
	"electron-v44.0.0-darwin-x64.zip": "28429e700ad68d9624aaa90b6543ffe891a48c14121fd904cd294e5edcee63ff",
	"electron-v44.0.0-linux-arm64.zip": "74b6f18bc29c0d52cf8e963c45d476800419097c6f3d53b27c5df335207e52bb",
	"electron-v44.0.0-linux-x64.zip": "d65286d812719f2b4c1a1b806a80f288a1058c89c7b058dae1e03ab25e499446",
	"electron-v44.0.0-win32-arm64.zip": "984c8f3b9ffaf3c0a3f3501c96277effc05a9f0df5a5d920b2610c09ebaf4368",
	"electron-v44.0.0-win32-x64.zip": "e61aa3bcea8152bc0730abd015e47c032d778a0ef10e2a1c78ba3c4ea47942f9"
};
/**
* Resolve the helper executable.
* `DSH_ORB_ELECTRON_PATH` wins. Otherwise use the cached official zip, downloading it once.
* @returns absolute path to the Electron executable.
*/
async function resolveElectronBinary() {
	const override = process.env.DSH_ORB_ELECTRON_PATH?.trim();
	if (override) {
		await access(override);
		return override;
	}
	const dest = dshHomePath("dsh-orb", "electron-runtime");
	const binary = join(dest, binaryRelative());
	const marker = join(dest, `.complete-${ELECTRON_VERSION}`);
	if (await exists(binary) && await exists(marker)) return binary;
	await downloadRuntime(dest, binary, marker);
	return binary;
}
async function downloadRuntime(dest, binary, marker) {
	const parent = dirname(dest);
	await mkdir(parent, { recursive: true });
	await withDownloadLock(parent, async () => {
		if (await exists(binary) && await exists(marker)) return;
		const fileName = assetName();
		console.error(`dsh-orb: downloading Electron ${ELECTRON_VERSION} (${fileName})`);
		const expected = expectedHash(await fetchText(`${RELEASE_BASE}/SHASUMS256.txt`), fileName);
		const stamp = randomBytes(8).toString("hex");
		const zipPath = join(parent, `.electron-${stamp}.zip`);
		const staging = join(parent, `.electron-staging-${stamp}`);
		try {
			await downloadVerifiedZip(fileName, expected, zipPath);
			await mkdir(staging, { recursive: true });
			await extractZip(zipPath, staging);
			const stagedBinary = join(staging, binaryRelative());
			if (process.platform === "darwin") await spawnChecked("/usr/bin/xattr", [
				"-dr",
				"com.apple.quarantine",
				staging
			]).catch(() => void 0);
			await chmod(stagedBinary, 493);
			await access(stagedBinary);
			await writeFile(join(staging, `.complete-${ELECTRON_VERSION}`), `${ELECTRON_VERSION}\n`);
			await replaceDirectory(staging, dest);
		} finally {
			await rm(zipPath, { force: true });
			await rm(staging, {
				recursive: true,
				force: true
			});
		}
		console.error(`dsh-orb: Electron ${ELECTRON_VERSION} is ready`);
	});
}
/** `mkdir` is the lock. A dead owner, or a lock older than 20 minutes, can be taken over. */
async function withDownloadLock(parent, task) {
	const lock = join(parent, "electron-runtime.download.lock");
	const deadline = Date.now() + 6e5;
	for (;;) try {
		await mkdir(lock);
		await writeFile(join(lock, "owner"), `${process.pid}\n${Date.now()}\n`);
		break;
	} catch (error) {
		if (!isEexist(error)) throw error;
		if (await lockExpired(lock)) {
			await rm(lock, {
				recursive: true,
				force: true
			});
			continue;
		}
		if (Date.now() > deadline) throw new Error("dsh-orb: Electron download is locked by another process");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	try {
		await task();
	} finally {
		await rm(lock, {
			recursive: true,
			force: true
		});
	}
}
async function lockExpired(lock) {
	try {
		const [pidText, startedText] = (await readFile(join(lock, "owner"), "utf8")).split("\n");
		const pid = Number(pidText);
		const started = Number(startedText);
		if (!Number.isInteger(pid) || pid <= 0) return true;
		if (Number.isFinite(started) && Date.now() - started > 12e5) return true;
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	} catch {
		return true;
	}
}
async function replaceDirectory(staging, dest) {
	const retired = `${dest}.retired-${randomBytes(4).toString("hex")}`;
	let moved = false;
	if (await exists(dest)) {
		await rename(dest, retired);
		moved = true;
	}
	try {
		await rename(staging, dest);
	} catch (error) {
		if (moved) await rename(retired, dest).catch(() => void 0);
		throw error;
	}
	if (moved) await rm(retired, {
		recursive: true,
		force: true
	}).catch(() => void 0);
}
function isEexist(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function assetName() {
	const platform = process.platform;
	const arch = process.arch;
	if (platform !== "darwin" && platform !== "win32" && platform !== "linux") throw new Error(`dsh-orb: unsupported platform ${platform}`);
	if (arch !== "arm64" && arch !== "x64") throw new Error(`dsh-orb: unsupported architecture ${arch}`);
	return `electron-v${ELECTRON_VERSION}-${platform}-${arch}.zip`;
}
function binaryRelative() {
	if (process.platform === "darwin") return join("Electron.app", "Contents", "MacOS", "Electron");
	if (process.platform === "win32") return "electron.exe";
	return "electron";
}
/** The hash written in source. `sums` must list the same value or the download stops. */
function expectedHash(sums, fileName) {
	const pinned = PINNED_SHA256[fileName];
	if (pinned === void 0) throw new Error(`dsh-orb: ${fileName} has no pinned Electron ${ELECTRON_VERSION} checksum`);
	if (hashFromSums(sums, fileName) !== pinned) throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum list does not match the pinned hash for ${fileName}`);
	return pinned;
}
function hashFromSums(sums, fileName) {
	for (const line of sums.split("\n")) {
		const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
		if (match?.[2] === fileName) return match[1].toLowerCase();
	}
	throw new Error(`dsh-orb: ${fileName} is missing from Electron ${ELECTRON_VERSION} checksums`);
}
const CURL_HTTPS = [
	"--proto",
	"=https",
	"--proto-redir",
	"=https"
];
async function fetchText(url) {
	const { stdout } = await run("curl", [
		"-fsSL",
		...CURL_HTTPS,
		"--max-time",
		"60",
		url
	]);
	return stdout;
}
async function downloadVerifiedZip(fileName, expected, dest) {
	const urls = [`${RELEASE_BASE}/${fileName}`, `https://cdn.npmmirror.com/binaries/electron/v${ELECTRON_VERSION}/${fileName}`];
	let lastError;
	for (const url of urls) try {
		await rm(dest, { force: true });
		await run("curl", [
			"-fsSL",
			...CURL_HTTPS,
			"--retry",
			"2",
			"--retry-delay",
			"1",
			"--speed-limit",
			"100000",
			"--speed-time",
			"20",
			"--max-time",
			"300",
			"-o",
			dest,
			url
		]);
		if (!sameHash(await sha256(dest), expected)) throw new Error(`dsh-orb: Electron ${ELECTRON_VERSION} checksum did not match SHASUMS256.txt`);
		return;
	} catch (error) {
		lastError = error;
		console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
	}
	throw lastError instanceof Error ? lastError : /* @__PURE__ */ new Error(`dsh-orb: failed to download Electron ${ELECTRON_VERSION}`);
}
function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		const out = [];
		const err = [];
		child.stdout?.on("data", (chunk) => out.push(chunk));
		child.stderr?.on("data", (chunk) => err.push(chunk));
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) {
				resolve({ stdout: Buffer.concat(out).toString("utf8") });
				return;
			}
			const detail = Buffer.concat(err).toString("utf8").trim();
			reject(/* @__PURE__ */ new Error(`dsh-orb: ${command} exited ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
		});
	});
}
async function sha256(path) {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), hash);
	return hash.digest("hex");
}
function sameHash(actual, expected) {
	const left = Buffer.from(actual, "hex");
	const right = Buffer.from(expected, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}
async function extractZip(zipPath, dest) {
	if (process.platform === "win32") {
		await spawnChecked("powershell.exe", [
			"-NoProfile",
			"-Command",
			`Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${dest.replaceAll("'", "''")}' -Force`
		]);
		return;
	}
	await spawnChecked(process.platform === "darwin" ? "/usr/bin/unzip" : "unzip", [
		"-q",
		"-o",
		zipPath,
		"-d",
		dest
	]);
}
function spawnChecked(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(/* @__PURE__ */ new Error(`dsh-orb: ${command} exited ${code ?? "unknown"}`));
		});
	});
}
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/open-main.ts
/**
* Focus the official desktop window, or open the local web page.
* The credentialed page address is never written to the log.
*/
/**
* Desktop uses the app's `dsh://open` protocol.
* `dsh web` has no main window, so the menu item stays disabled and this returns undefined.
* The credentialed loopback URL is never passed to `open` or `cmd`.
*/
function mainWindowTarget(_ctx, desktop = isDesktopHost()) {
	if (desktop) return "dsh://open";
}
/** Command used to focus that window. The target is never logged. */
function openCommand(target, platform = process.platform) {
	if (platform === "win32") return {
		command: "cmd",
		args: [
			"/c",
			"start",
			"",
			target
		]
	};
	return {
		command: "open",
		args: [target]
	};
}
/** Focus the desktop main window. Does nothing when this host is `dsh web`. */
async function openMainWindow(ctx) {
	const target = mainWindowTarget(ctx);
	if (target === void 0) return;
	await spawnOpen(target);
}
function spawnOpen(target) {
	const { command, args } = openCommand(target);
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			windowsHide: true
		});
		child.once("error", () => {
			console.error("dsh-orb: could not open the main window");
			resolve();
		});
		child.once("exit", (code) => {
			if (code !== 0) console.error("dsh-orb: could not open the main window");
			resolve();
		});
	});
}
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}
function createOverlayGuard(transport) {
	let inputDepth = 0;
	let captureDepth = 0;
	const sleep = transport.sleep ?? delay;
	return {
		async withCapture(run, signal) {
			captureDepth += 1;
			const cloaked = captureDepth === 1 && inputDepth === 0 && transport.hasHelper();
			let sentBegin = false;
			try {
				if (cloaked) {
					const begin = transport.send({
						type: "overlay-capture",
						id: randomUUID(),
						active: true
					}, signal);
					sentBegin = true;
					await begin;
					await sleep(50);
				}
				return await run({ excludeWindowIds: [] });
			} finally {
				captureDepth -= 1;
				if (sentBegin) try {
					await transport.send({
						type: "overlay-capture",
						id: randomUUID(),
						active: false
					});
				} catch {}
			}
		},
		async withInput(run) {
			inputDepth += 1;
			const outer = inputDepth === 1;
			const cloaked = outer && transport.hasHelper();
			try {
				if (outer) {
					transport.setHidInput(true);
					if (cloaked) await transport.send({
						type: "overlay-input",
						id: randomUUID(),
						active: true
					});
				}
				const value = await run();
				if (cloaked) await sleep(80);
				return value;
			} finally {
				inputDepth -= 1;
				if (inputDepth === 0) try {
					if (cloaked) await transport.send({
						type: "overlay-input",
						id: randomUUID(),
						active: false
					});
				} finally {
					transport.setHidInput(false);
				}
			}
		},
		async setObservationFrame(bounds, signal) {
			if (!transport.hasHelper()) return;
			if (bounds !== null && signal?.aborted) {
				await transport.send({
					type: "observation-frame",
					id: randomUUID(),
					bounds: null
				});
				return;
			}
			try {
				await transport.send({
					type: "observation-frame",
					id: randomUUID(),
					bounds
				}, signal);
			} catch (error) {
				if (bounds !== null && signal?.aborted) {
					await transport.send({
						type: "observation-frame",
						id: randomUUID(),
						bounds: null
					});
					return;
				}
				throw error;
			}
		}
	};
}
const SELECTION_ACCESSIBILITY_POLL_MS = 1e3;
const SELECTION_PREAMBLE = "Desktop selection. Answer in this chat only. Do not call GUI tools or code_agent.";
function selectionSearchUrl(text) {
	return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}
function composeSelectionTranslatePrompt(text, language) {
	return `${SELECTION_PREAMBLE}\n\nTranslate the following into ${language === "en" ? "English" : "Chinese"}:\n\n${text}`;
}
/** Open a URL with the system handler. Search uses this and does not expand the ball. */
function openSystemUrl(url) {
	const command = process.platform === "win32" ? "cmd" : "open";
	const args = process.platform === "win32" ? [
		"/c",
		"start",
		"",
		url
	] : [url];
	const child = spawn(command, args, {
		stdio: "ignore",
		windowsHide: true
	});
	child.once("error", (error) => {
		console.error(`dsh-orb: open failed: ${error.message}`);
	});
	child.unref();
}
var SelectionController = class {
	host;
	startMonitor;
	monitor;
	lastText = "";
	lastAnchor = {
		x: 0,
		y: 0
	};
	lastDedupe;
	lastPid;
	restoreTimer;
	sessionRunning = false;
	hidInput = false;
	promptedAccessibility = false;
	accessibilityPoll;
	constructor(host, startMonitor = startSelectionMonitor) {
		this.host = host;
		this.startMonitor = startMonitor;
	}
	/** Start while the helper is connected and the switch is on. */
	sync() {
		if (process.platform === "linux") return;
		if (this.host.helperConnected() && this.host.enabled()) this.start();
		else this.stop();
	}
	stop() {
		this.clearAccessibilityPoll();
		this.monitor?.stop();
		this.monitor = void 0;
		if (this.restoreTimer !== void 0) {
			clearTimeout(this.restoreTimer);
			this.restoreTimer = void 0;
		}
		this.host.hide();
	}
	setLanguage(language) {
		this.host.setLanguage(language);
	}
	setSessionRunning(running) {
		this.sessionRunning = running;
		if (running) this.host.hide();
	}
	setHidInput(active) {
		this.hidInput = active;
		if (active) this.host.hide();
	}
	search() {
		if (this.lastText === "") return;
		this.host.hide();
		this.host.openExternal(selectionSearchUrl(this.lastText));
	}
	translate() {
		if (this.lastText === "") return;
		const text = composeSelectionTranslatePrompt(this.lastText, this.host.language());
		this.host.hide();
		this.host.prompt(text);
		this.scheduleRestoreFrontApp();
	}
	sendToAgent() {
		if (this.lastText === "") return;
		this.host.hide();
		this.host.attach(this.lastText);
	}
	onHelperEvent(event) {
		switch (event.type) {
			case "ready":
				this.exclude();
				return;
			case "untrusted":
				if (!this.promptedAccessibility) {
					this.promptedAccessibility = true;
					this.host.requestAccessibility();
				}
				this.watchAccessibility();
				return;
			case "mouse-down":
				this.host.pointer(event.x, event.y);
				return;
			case "key":
			case "dismiss":
				this.host.hide();
				return;
			case "mouse-up":
				this.lastAnchor = {
					x: event.x,
					y: event.y
				};
				return;
			case "selection":
				this.onSelection(event);
				return;
		}
	}
	start() {
		if (this.monitor !== void 0) return;
		const started = this.startMonitor({ onEvent: (event) => {
			this.onHelperEvent(event);
		} });
		if (started === void 0) return;
		this.monitor = started;
		this.exclude();
	}
	exclude() {
		const pids = [process.pid];
		const helper = this.host.helperPid();
		if (helper !== void 0) pids.push(helper);
		this.monitor?.setExcludePids(pids);
	}
	pausedReads() {
		return this.sessionRunning || this.hidInput || !this.host.enabled();
	}
	onSelection(event) {
		if (this.pausedReads()) return;
		const key = `${String(event.pid ?? 0)}\0${event.bundle ?? ""}\0${event.text}`;
		const now = this.host.now();
		if (this.lastDedupe !== void 0 && this.lastDedupe.key === key && now - this.lastDedupe.at < 3e3) return;
		this.lastDedupe = {
			key,
			at: now
		};
		this.lastText = event.text;
		this.lastPid = event.pid;
		if (event.x !== void 0 && event.y !== void 0) this.lastAnchor = {
			x: event.x,
			y: event.y
		};
		this.host.show({
			text: event.text,
			x: this.lastAnchor.x,
			y: this.lastAnchor.y,
			language: this.host.language()
		});
	}
	scheduleRestoreFrontApp() {
		this.restoreFrontApp();
		if (this.restoreTimer !== void 0) clearTimeout(this.restoreTimer);
		const timer = setTimeout(() => {
			this.restoreTimer = void 0;
			this.restoreFrontApp();
		}, 80);
		timer.unref();
		this.restoreTimer = timer;
	}
	restoreFrontApp() {
		const pid = this.lastPid;
		if (pid === void 0 || pid === process.pid) return;
		this.monitor?.activatePid(pid);
	}
	watchAccessibility() {
		if (this.accessibilityPoll !== void 0) return;
		const timer = setInterval(() => {
			if (!this.host.enabled() || this.monitor === void 0) {
				this.clearAccessibilityPoll();
				return;
			}
			if (!this.host.accessibilityTrusted()) return;
			this.rearm();
		}, SELECTION_ACCESSIBILITY_POLL_MS);
		timer.unref();
		this.accessibilityPoll = timer;
	}
	rearm() {
		this.clearAccessibilityPoll();
		this.monitor?.stop();
		this.monitor = void 0;
		this.start();
	}
	clearAccessibilityPoll() {
		if (this.accessibilityPoll === void 0) return;
		clearInterval(this.accessibilityPoll);
		this.accessibilityPoll = void 0;
	}
};
function productionAccessibility() {
	return {
		requestAccessibility: () => promptAccessibility(),
		accessibilityTrusted: () => accessibilityTrusted()
	};
}
//#endregion
//#region src/select-model.ts
/**
* Official `selectModel` always writes the chosen model as the global default.
* A later `saveSelection` is queued behind that write, so the previous default is restored.
* Those settings fields are volatile, so the write does not restart plugins.
*
* Calls are serialized across every copy of this module in the process, so the ball and `code_agent`
* cannot interleave their select and restore steps. A short window still remains: official
* `selectModel` has no session-only option, so another window that creates a session between the
* official write and the restore sees the chosen model once.
*/
const QUEUE = Symbol.for("dsh-orb.select-model.queue");
function enqueue(task) {
	const holder = globalThis;
	const run = (holder[QUEUE] ?? Promise.resolve()).then(task, task);
	holder[QUEUE] = run.catch(() => void 0);
	return run;
}
/** Apply a model to one session, then put the global default back if it changed. */
function selectModelKeepDefault(ctx, request) {
	return enqueue(() => selectAndRestore(ctx, request));
}
async function selectAndRestore(ctx, request) {
	const defaults = ctx.agentDefaultModel;
	const previous = defaults?.currentSelection();
	const chosen = {
		provider: request.provider,
		model: request.model,
		...request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }
	};
	await ctx.sessionController.selectModel({
		sessionId: request.sessionId,
		...chosen
	});
	if (defaults === void 0) {
		console.error("dsh-orb: agentDefaultModel is missing; a session model may replace the global default");
		return;
	}
	if (previous === void 0 || sameSelection(previous, chosen)) return;
	await defaults.saveSelection(previous);
	console.error("dsh-orb: restored the global default model after a session-only selection");
}
function sameSelection(left, right) {
	return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
//#endregion
//#region src/orb.ts
/**
* NDJSON control plane for the ball, plus the Computer Use session it talks to.
* The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
*/
/** One host lifetime of the ball: socket, helper process, and one Computer Use session. */
var OrbRuntime = class {
	ctx;
	store;
	token = randomBytes(32).toString("hex");
	sessionFile = dshHomePath("dsh-orb", "floating-session.json");
	server;
	port = 0;
	sockets = /* @__PURE__ */ new Set();
	buffers = /* @__PURE__ */ new Map();
	blocks = /* @__PURE__ */ new Map();
	blockOrder = [];
	pending;
	questionBody;
	turnRunning = false;
	turnInterrupted = false;
	child;
	binary = "";
	failures = 0;
	halted = false;
	generation = 0;
	replaying = false;
	workspaceTask;
	retry;
	opening = false;
	pendingStart = false;
	helperError;
	userData = "";
	idleWarned = false;
	sessionId;
	sessionError;
	creating;
	watermark = 0;
	missingLogged = false;
	timer;
	giveUp;
	dirty = /* @__PURE__ */ new Set();
	dirtyTimer;
	/** Chunk frames carry no turn/step; only the attempt's start frame does. */
	attemptPositions = /* @__PURE__ */ new Map();
	lastAttemptByStep = /* @__PURE__ */ new Map();
	/** Transient block keys one streaming step created, in creation order. */
	stepBlocks = /* @__PURE__ */ new Map();
	liveStep;
	orphanFrameLogged = false;
	/** Keys of the newest settled assistant message: the turn's final answer so far. */
	responseKeys = [];
	helperPid;
	appearance = {};
	overlayWaiters = /* @__PURE__ */ new Map();
	tcc;
	selection;
	overlay = createOverlayGuard({
		hasHelper: () => this.sockets.size > 0,
		send: (message, signal) => this.waitAck(message, signal),
		setHidInput: (active) => {
			this.selection.setHidInput(active);
		}
	});
	constructor(ctx, store, options = {}) {
		this.ctx = ctx;
		this.store = store;
		this.tcc = options.tcc ?? new TccMonitor();
		const access = productionAccessibility();
		this.selection = new SelectionController({
			enabled: () => this.store.selectionEnabled(),
			language: () => this.store.translateLanguage(),
			setLanguage: (language) => {
				this.store.setTranslateLanguage(language);
				this.broadcast({
					type: "selection-language",
					language
				});
			},
			helperConnected: () => this.sockets.size > 0,
			helperPid: () => this.helperPid,
			show: (payload) => {
				this.broadcast({
					type: "selection",
					...payload
				});
			},
			hide: () => {
				this.broadcast({ type: "selection-hide" });
			},
			pointer: (x, y) => {
				this.broadcast({
					type: "selection-pointer",
					x,
					y
				});
			},
			attach: (text) => {
				this.broadcast({
					type: "selection-attach",
					text
				});
			},
			prompt: (text) => {
				this.onPrompt(text);
			},
			openExternal: (url) => {
				openSystemUrl(url);
			},
			requestAccessibility: () => access.requestAccessibility(),
			accessibilityTrusted: () => access.accessibilityTrusted(),
			now: () => Date.now()
		}, options.startMonitor);
		ctx.provide("computerUseOverlayGuard", this.overlay);
		this.listenAssistantStream();
	}
	/**
	* Follow the loop's process-local assistant stream so text, thinking, and tool
	* calls reach the ball while the model is still producing them. The durable
	* log only records the settled message, which is what the 400 ms poll sees.
	*/
	listenAssistantStream() {
		try {
			this.ctx.on("agent/assistant-stream", (payload) => this.onAssistantStream(payload), { global: true });
		} catch (error) {
			console.error(`dsh-orb: assistant stream unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	onAssistantStream(payload) {
		if (this.sessionId === void 0) return;
		const record = asRecord(payload);
		if (asRecord(asRecord(record?.agent)?.session)?.id !== this.sessionId) return;
		const frame = asRecord(record?.frame);
		if (!frame) return;
		const attemptId = typeof frame.attemptId === "string" ? frame.attemptId : "";
		if (frame.type === "start") {
			if (attemptId === "") return;
			const turn = numberOf(frame.turn);
			const step = numberOf(frame.step);
			this.attemptPositions.set(attemptId, {
				turn,
				step
			});
			const stepKey = `${turn}:${step}`;
			const previous = this.lastAttemptByStep.get(stepKey);
			this.lastAttemptByStep.set(stepKey, attemptId);
			if (previous !== void 0 && previous !== attemptId) this.rewindLiveStep(turn, step);
			return;
		}
		if (frame.type === "end") {
			this.attemptPositions.delete(attemptId);
			return;
		}
		if (frame.type !== "chunk") return;
		const position = this.attemptPositions.get(attemptId);
		if (position === void 0) {
			if (!this.orphanFrameLogged) {
				this.orphanFrameLogged = true;
				console.error("dsh-orb: assistant stream chunk arrived without its start frame");
			}
			return;
		}
		if (!asRecord(frame.chunk)) return;
		this.onChunk({
			turn: position.turn,
			step: position.step,
			chunk: frame.chunk
		});
	}
	/** A new attempt supersedes the dead one: drop its transient blocks so the retry streams into a clean slate. */
	rewindLiveStep(turn, step) {
		const tracked = this.stepBlocks.get(`${turn}:${step}`);
		if (!tracked) return;
		this.stepBlocks.delete(`${turn}:${step}`);
		for (const key of tracked) this.dropBlock(key);
	}
	/** Open the socket, prepare a session, and spawn the helper. A halted ball can start again. */
	async start() {
		if (process.platform === "linux") return;
		this.halted = false;
		this.failures = 0;
		this.helperError = void 0;
		if (this.child !== void 0 && this.child.exitCode === null && this.child.signalCode === null && this.server) return;
		if (this.retry) clearTimeout(this.retry);
		this.retry = void 0;
		if (this.opening) {
			this.generation += 1;
			this.pendingStart = true;
			return;
		}
		this.opening = true;
		this.generation += 1;
		const generation = this.generation;
		try {
			await this.begin(generation);
		} finally {
			this.opening = false;
			if (this.pendingStart) {
				this.pendingStart = false;
				if (!this.halted) await this.start();
			}
		}
	}
	/** Short code the settings page can show after the helper gives up. */
	helperStatus() {
		return this.helperError ?? "";
	}
	async begin(generation) {
		if (!this.server) await this.listen();
		if (this.halted || generation !== this.generation) {
			this.server?.close();
			this.server = void 0;
			return;
		}
		console.error(`dsh-orb: helper socket 127.0.0.1:${this.port}`);
		const sessionTask = this.ensureSession().catch((error) => {
			this.sessionError = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: session setup failed: ${this.sessionError}`);
		});
		try {
			this.binary = await resolveElectronBinary();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: ${message}`);
			this.helperError = "runtime-download";
			this.server?.close();
			this.server = void 0;
			return;
		}
		await sessionTask;
		if (this.halted || generation !== this.generation) return;
		this.userData = helperDataDirectory(this.store.dir);
		await mkdir(this.userData, { recursive: true });
		this.launch();
	}
	/**
	* Open the control socket without spawning the helper.
	* {@link start} listens and then launches the helper process.
	*/
	async bind() {
		if (!this.server) await this.listen();
		return {
			port: this.port,
			token: this.token
		};
	}
	/** Stop the helper and the socket. Settings can call {@link start} again. */
	halt() {
		this.generation += 1;
		this.halted = true;
		this.pendingStart = false;
		if (this.retry) clearTimeout(this.retry);
		this.retry = void 0;
		this.stopWatch();
		this.clearDirty();
		this.handQuestionBack();
		this.server?.close();
		this.server = void 0;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.buffers.clear();
		this.helperPid = void 0;
		this.overlayWaiters.clear();
		this.selection.stop();
		this.killChild();
	}
	/** Claim questions for this orb session. Register this while the plugin fiber is active. */
	attachQuestions() {
		try {
			const dispose = this.ctx.on("user-questions/request", (request, next) => this.onQuestion(request, next), { prepend: true });
			return typeof dispose === "function" ? dispose : () => {};
		} catch (error) {
			console.error(`dsh-orb: question listener failed: ${error instanceof Error ? error.message : String(error)}`);
			return () => {};
		}
	}
	async listen() {
		const server = createServer((socket) => {
			this.handle(socket);
		});
		this.server = server;
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("dsh-orb: helper socket has no port");
		this.port = address.port;
	}
	handle(socket) {
		socket.setEncoding("utf8");
		let authed = false;
		const timer = setTimeout(() => {
			if (!authed) socket.destroy();
		}, 3e3);
		timer.unref();
		socket.on("data", (chunk) => {
			const next = `${this.buffers.get(socket) ?? ""}${chunk}`;
			if (next.length > 1e6) {
				socket.destroy();
				return;
			}
			const parts = next.split("\n");
			this.buffers.set(socket, parts.pop() ?? "");
			for (const part of parts) {
				if (!part.trim()) continue;
				let message;
				try {
					message = JSON.parse(part);
				} catch {
					socket.destroy();
					return;
				}
				if (!authed) {
					if (!this.helloOk(message)) {
						socket.destroy();
						return;
					}
					authed = true;
					clearTimeout(timer);
					this.accept(socket, message);
					continue;
				}
				if (isPrompt(message)) this.onPrompt(message.text);
				else if (isQuestionAnswer(message)) this.onQuestionAnswer(message.id, message.answers);
				else if (isQuestionCancel(message)) this.onQuestionCancel(message.id);
				else this.onControl(message);
			}
		});
		socket.on("close", () => {
			this.sockets.delete(socket);
			this.buffers.delete(socket);
			if (this.sockets.size === 0) {
				this.handQuestionBack();
				this.helperPid = void 0;
				this.selection.stop();
			}
		});
		socket.on("error", () => {
			socket.destroy();
		});
	}
	helloOk(message) {
		if (typeof message !== "object" || message === null) return false;
		const record = message;
		if (record.type !== "hello" || typeof record.token !== "string") return false;
		const given = Buffer.from(record.token);
		const expected = Buffer.from(this.token);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}
	accept(socket, hello) {
		const pid = asRecord(hello)?.pid;
		if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) this.helperPid = pid;
		this.sockets.add(socket);
		if (this.sessionId) this.send(socket, {
			type: "session",
			sessionId: this.sessionId
		});
		if (this.blockOrder.length === 0 && this.sessionId) {
			this.replaying = true;
			this.drain();
			this.replaying = false;
		} else for (const key of this.blockOrder) {
			const block = this.blocks.get(key);
			if (block) this.send(socket, block);
		}
		this.send(socket, {
			type: "turn",
			running: this.turnRunning
		});
		if (Object.keys(this.appearance).length > 0) this.send(socket, {
			type: "appearance",
			...this.appearance
		});
		if (this.pending) this.send(socket, this.questionPayload(this.pending.id));
		this.publishChrome();
		this.selection.sync();
	}
	async onPrompt(text) {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.turnInterrupted = false;
		this.block(`user:${randomUUID()}`, "user", trimmed, false, "set");
		this.turnRunning = true;
		this.selection.setSessionRunning(true);
		this.broadcast({
			type: "turn",
			running: true
		});
		if (this.sessionError && !this.sessionId) {
			this.turnRunning = false;
			this.selection.setSessionRunning(false);
			this.broadcast({
				type: "turn",
				running: false
			});
			this.status(this.sessionError);
			return;
		}
		try {
			const sessionId = await this.ensureSession();
			if (!this.timer) this.syncWatermark();
			this.watch();
			await this.ctx.sessionController.prompt({
				requestId: randomUUID(),
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text: trimmed
				}],
				clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
			}, new AbortController().signal);
			this.drain();
		} catch (error) {
			this.finishTurn();
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: prompt failed: ${message}`);
			this.status(message);
		}
	}
	async ensureSession() {
		if (this.sessionId) return this.sessionId;
		this.creating ??= this.createSession().finally(() => {
			this.creating = void 0;
		});
		return this.creating;
	}
	async createSession() {
		const workspaceId = await this.workspaceId();
		const saved = await readSavedSession(this.sessionFile);
		try {
			const session = await this.ctx.sessionController.create({
				workspaceId,
				agentPreset: "computer-use",
				...saved ? { sessionId: saved } : {}
			});
			return this.adopt(session.sessionId);
		} catch (error) {
			if (!saved) throw error;
			console.error("dsh-orb: saved session cannot be opened; creating a new one");
			await rm(this.sessionFile, { force: true });
			const session = await this.ctx.sessionController.create({
				workspaceId,
				agentPreset: "computer-use"
			});
			return this.adopt(session.sessionId);
		}
	}
	workspaceId() {
		this.workspaceTask ??= this.createWorkspace().catch((error) => {
			this.workspaceTask = void 0;
			throw error;
		});
		return this.workspaceTask;
	}
	async createWorkspace() {
		const workspace = dshHomePath("dsh_orb");
		await mkdir(workspace, { recursive: true });
		return (await this.ctx.workspaceController.create({ path: workspace })).workspace.workspaceId;
	}
	async adopt(sessionId) {
		const id = await this.remember(sessionId);
		await this.applyOverlayQuiet(id);
		pinSessionId(this.ctx, id, this.store.permission());
		return id;
	}
	async remember(sessionId) {
		this.sessionId = sessionId;
		this.sessionError = void 0;
		try {
			await mkdir(dirname(this.sessionFile), { recursive: true });
			await writeFile(this.sessionFile, `${JSON.stringify({ sessionId })}\n`);
		} catch (error) {
			console.error(`dsh-orb: could not save session id: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.broadcast({
			type: "session",
			sessionId
		});
		console.error(`dsh-orb: session ${sessionId}`);
		return sessionId;
	}
	syncWatermark() {
		if (!this.sessionId) return;
		const session = this.ctx.sessions.get(this.sessionId);
		if (!session) return;
		for (const event of session.snapshotEvents()) {
			const seq = Number(event.seq);
			if (seq > this.watermark) this.watermark = seq;
		}
	}
	watch() {
		if (!this.timer) this.timer = setInterval(() => this.drain(), 400);
		this.armIdle();
	}
	/** Warn after 3 quiet minutes, but keep polling until the session goes idle. */
	armIdle() {
		if (this.giveUp) clearTimeout(this.giveUp);
		this.giveUp = setTimeout(() => {
			if (!this.turnRunning) return;
			if (this.pending) {
				this.armIdle();
				return;
			}
			if (!this.idleWarned) {
				this.idleWarned = true;
				this.status("等待超时");
			}
		}, 18e4);
	}
	stopWatch() {
		if (this.timer) clearInterval(this.timer);
		this.timer = void 0;
		if (this.giveUp) clearTimeout(this.giveUp);
		this.giveUp = void 0;
	}
	drain() {
		if (!this.sessionId) return;
		const session = this.ctx.sessions.get(this.sessionId);
		if (!session) {
			if (!this.missingLogged) {
				this.missingLogged = true;
				console.error("dsh-orb: session is not in the store yet");
			}
			return;
		}
		this.missingLogged = false;
		let fresh = false;
		try {
			for (const event of session.snapshotEvents()) {
				const seq = Number(event.seq);
				if (seq <= this.watermark) continue;
				this.watermark = seq;
				fresh = true;
				this.consume(event.type, event.data, seq);
			}
		} catch (error) {
			console.error(`dsh-orb: transcript read failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (fresh && this.turnRunning) {
			this.idleWarned = false;
			this.armIdle();
		}
	}
	consume(type, data, seq) {
		if (type === "user/message") {
			if (!this.replaying) return;
			const text = userText(data);
			if (!text.trim()) return;
			this.block(`user:${seq}`, "user", text, false, "set");
			return;
		}
		if (type === "assistant/chunk") {
			this.onChunk(data);
			return;
		}
		if (type === "assistant/message") {
			this.onAssistant(data);
			return;
		}
		if (type === "tool/call") {
			const name = toolName(data);
			if (!name) return;
			const id = callId(data);
			const existing = id ? void 0 : this.runningTool(name);
			const key = id ? `tool:${id}` : existing ?? `tool:${seq}`;
			this.block(key, "tool", name, false, "set", { args: clip(toolArguments(data), 4e3) });
			return;
		}
		if (type === "tool/result") {
			this.onToolResult(data);
			return;
		}
		if (type === "turn/end") this.finishTurn();
	}
	/** Join a settled result to its call by id, carrying error state and meta. */
	onToolResult(data) {
		const record = asRecord(data);
		if (!record) return;
		const id = callId(record);
		const message = asRecord(record.message);
		const callIdValue = id || (message ? callIdValueOf(message) : "");
		if (!callIdValue) return;
		const key = `tool:${callIdValue}`;
		const existing = this.blocks.get(key);
		const name = existing?.kind === "tool" ? existing.text : toolName(record) || "";
		const content = Array.isArray(message?.content) ? message?.content : [];
		const error = asRecord(record.error);
		const detail = {
			args: existing?.detail?.args ?? "",
			result: clip(resultText(content, error ?? void 0), 8e3),
			isError: message?.isError === true,
			...error === void 0 ? {} : { error: {
				name: typeof error.name === "string" ? error.name : "Error",
				code: typeof error.code === "string" ? error.code : "unknown",
				...typeof error.reason === "string" ? { reason: clip(error.reason, 2e3) } : {}
			} },
			meta: clip(jsonText(record.meta), 12e3),
			cwd: this.sessionCwd()
		};
		this.block(key, "tool", name, false, "set", detail);
	}
	sessionCwd() {
		if (!this.sessionId) return "";
		return this.ctx.sessions.get(this.sessionId)?.header?.cwd ?? "";
	}
	onChunk(data) {
		const record = asRecord(data);
		const chunk = asRecord(record?.chunk);
		if (!record || !chunk) return;
		const turn = numberOf(record.turn);
		const step = numberOf(record.step);
		const index = numberOf(chunk.index);
		const key = `b:${turn}:${step}:${index}`;
		this.liveStep = `${turn}:${step}`;
		try {
			if (chunk.type === "text-delta" && typeof chunk.text === "string") {
				this.block(key, "assistant", chunk.text, true, "append");
				return;
			}
			if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
				this.block(key, "reasoning", chunk.text, true, "append");
				return;
			}
			if (chunk.type === "tool-call-delta") {
				const name = typeof chunk.name === "string" ? chunk.name : "";
				if (!name) return;
				const id = typeof chunk.id === "string" ? chunk.id : "";
				const delta = typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "";
				const toolKey = id ? `tool:${id}` : `b:${turn}:${step}:${index}`;
				const previous = this.blocks.get(toolKey);
				this.block(toolKey, "tool", name, true, "set", { args: clip(`${previous?.detail?.args ?? ""}${delta}`, 4e3) });
				return;
			}
			if (chunk.type === "block-end") this.applyContent(key, chunk.block, false);
		} finally {
			this.liveStep = void 0;
		}
	}
	/**
	* Settle one assistant message like Harness settleAssistant: the transient
	* streamed blocks are consumed in place (kind + order) and whatever the
	* message did not claim is dropped, so no stale copy can survive the fold.
	*/
	onAssistant(data) {
		const record = asRecord(data);
		if (!record) return;
		const turn = numberOf(record.turn);
		const step = numberOf(record.step);
		const usage = readUsage(record.usage);
		if (record.interrupted === true) this.turnInterrupted = true;
		const previous = this.responseKeys;
		this.responseKeys = [];
		for (const key of previous) {
			const item = this.blocks.get(key);
			if (item?.response === true) this.block(key, item.kind, item.text, false, "set");
		}
		const content = asRecord(record.message)?.content;
		const parts = typeof content === "string" ? [{
			type: "text",
			text: content
		}] : Array.isArray(content) ? content : [];
		const transient = this.stepBlocks.get(`${turn}:${step}`) ?? [];
		this.stepBlocks.delete(`${turn}:${step}`);
		const writtenKeys = [];
		let cursor = 0;
		for (const [index, part] of parts.entries()) {
			const wanted = partKind(asRecord(part));
			let key;
			if (wanted !== void 0) while (cursor < transient.length) {
				const candidate = transient[cursor];
				cursor += 1;
				if (this.blocks.get(candidate)?.kind === wanted) {
					key = candidate;
					break;
				}
				this.dropBlock(candidate);
			}
			key ??= `b:${turn}:${step}:${index}`;
			const written = this.applyContent(key, part, false);
			if (written === void 0 || written !== key) this.dropBlock(key);
			if (written !== void 0) writtenKeys.push(written);
		}
		while (cursor < transient.length) {
			this.dropBlock(transient[cursor]);
			cursor += 1;
		}
		this.responseKeys = writtenKeys;
		if (usage !== void 0) {
			const last = [...writtenKeys].reverse().find((key) => this.blocks.get(key)?.kind === "assistant");
			const settled = last === void 0 ? void 0 : this.blocks.get(last);
			if (last !== void 0 && settled) this.block(last, settled.kind, settled.text, false, "set", void 0, usage);
		}
	}
	/** Remove one block everywhere: map, order, and the ball's DOM. */
	dropBlock(key) {
		if (!this.blocks.delete(key)) return;
		const at = this.blockOrder.indexOf(key);
		if (at >= 0) this.blockOrder.splice(at, 1);
		this.dirty.delete(key);
		this.publish({
			type: "block-drop",
			key
		});
	}
	/** Write one content part. Returns the key it landed on, or `undefined` when the part is skipped. */
	applyContent(key, part, running) {
		const block = asRecord(part);
		if (!block) return void 0;
		if ((block.type === "text" || block.type === "reasoning" || block.type === "thinking") && typeof block.text === "string") {
			if (!block.text.trim()) return void 0;
			const kind = block.type === "text" ? "assistant" : "reasoning";
			this.block(key, kind, block.text, running, "set");
			return key;
		}
		if (block.type !== "tool-call" && block.type !== "tool_use") return void 0;
		const name = typeof block.name === "string" ? block.name : "";
		if (!name) return void 0;
		const id = typeof block.id === "string" ? block.id : typeof block.callId === "string" ? block.callId : "";
		const toolKey = id ? `tool:${id}` : key;
		this.block(toolKey, "tool", name, running, "set", { args: clip(typeof block.arguments === "string" ? block.arguments : "", 4e3) });
		return toolKey;
	}
	runningTool(name) {
		for (const key of this.blockOrder) {
			const block = this.blocks.get(key);
			if (block?.kind === "tool" && block.text === name && block.running) return key;
		}
	}
	finishTurn() {
		this.turnRunning = false;
		this.idleWarned = false;
		this.selection.setSessionRunning(false);
		for (const key of [...this.blockOrder]) if (this.blocks.get(key)?.running) this.settleBlock(key);
		this.stepBlocks.clear();
		this.lastAttemptByStep.clear();
		for (const key of [...this.responseKeys]) {
			const item = this.blocks.get(key);
			if (item) this.block(key, item.kind, item.text, false, "set");
		}
		this.responseKeys = [];
		this.broadcast({
			type: "turn",
			running: false,
			...this.turnInterrupted ? { interrupted: true } : {}
		});
		this.turnInterrupted = false;
		this.stopWatch();
		const reply = [...this.blockOrder].reverse().map((key) => this.blocks.get(key)).find((item) => item?.kind === "assistant");
		console.error(`dsh-orb: turn done reply=${reply?.text.length ?? 0}`);
	}
	/** Flip one leftover running block to settled, bypassing the empty-text guard in {@link block}. */
	settleBlock(key) {
		const previous = this.blocks.get(key);
		if (!previous) return;
		const message = {
			...previous,
			running: false,
			...this.turnInterrupted && previous.kind === "assistant" ? { interrupted: true } : {}
		};
		this.blocks.set(key, message);
		this.dirty.delete(key);
		this.publish(message);
	}
	block(key, kind, text, running, mode, detail, usage) {
		const previous = this.blocks.get(key);
		const previousText = previous?.text ?? "";
		const next = clip(mode === "append" ? `${previousText}${text}` : text, 2e4);
		if (!next.trim() && kind !== "tool") return;
		const mergedDetail = detail === void 0 ? previous?.detail : {
			args: detail.args ?? previous?.detail?.args ?? "",
			result: detail.result ?? previous?.detail?.result ?? "",
			isError: detail.isError ?? previous?.detail?.isError ?? false,
			error: detail.error ?? previous?.detail?.error,
			meta: detail.meta ?? previous?.detail?.meta ?? "",
			cwd: detail.cwd ?? previous?.detail?.cwd ?? ""
		};
		const merged = mergedDetail === void 0 ? void 0 : {
			...mergedDetail,
			...mergedDetail.error === void 0 ? {} : { error: mergedDetail.error }
		};
		const mergedUsage = usage === void 0 ? previous?.usage : usage;
		const message = {
			type: "block",
			key,
			kind,
			text: next,
			running,
			...this.turnInterrupted && kind === "assistant" && !running ? { interrupted: true } : {},
			...this.responseKeys.includes(key) ? { response: true } : {},
			...merged === void 0 ? {} : { detail: merged },
			...mergedUsage === void 0 ? {} : { usage: mergedUsage }
		};
		if (!this.blocks.has(key)) {
			this.blockOrder.push(key);
			if (this.liveStep !== void 0) {
				const tracked = this.stepBlocks.get(this.liveStep);
				if (tracked) tracked.push(key);
				else this.stepBlocks.set(this.liveStep, [key]);
			}
			while (this.blockOrder.length > 200) {
				const dropped = this.blockOrder.shift();
				if (dropped) {
					this.blocks.delete(dropped);
					this.dirty.delete(dropped);
				}
			}
		}
		this.blocks.set(key, message);
		if (running) {
			this.dirty.add(key);
			this.dirtyTimer ??= setTimeout(() => this.flushDirty(), 60);
			return;
		}
		this.dirty.delete(key);
		this.publish(message);
	}
	/** Broadcast with global FIFO: pending coalesced updates go out before anything newer. */
	publish(message) {
		this.flushDirty();
		this.broadcast(message);
	}
	/** Coalesce per-token running-block updates; settled blocks always go out immediately. */
	flushDirty() {
		this.dirtyTimer = void 0;
		const keys = [...this.dirty];
		this.dirty.clear();
		for (const key of keys) {
			const message = this.blocks.get(key);
			if (message) this.broadcast(message);
		}
	}
	clearDirty() {
		if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
		this.dirtyTimer = void 0;
		this.dirty.clear();
	}
	status(text) {
		this.broadcast({
			type: "status",
			text: clip(text, 500)
		});
	}
	onQuestion(request, next) {
		const agentId = typeof request.agent?.id === "string" ? request.agent.id : "";
		const questions = sanitizeQuestions(request.questions);
		if (this.sockets.size === 0 || !this.sessionId || agentId !== this.sessionId || this.pending || questions.length === 0) {
			if (this.sessionId && agentId === this.sessionId) console.error(`dsh-orb: question deferred sockets=${this.sockets.size} pending=${this.pending !== void 0} count=${questions.length}`);
			return next();
		}
		console.error(`dsh-orb: question card ${questions.length}`);
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.pending = {
				id,
				resolve,
				reject,
				next
			};
			this.questionBody = questions;
			this.broadcast(this.questionPayload(id));
			const signal = request.signal;
			const onAbort = () => {
				this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED", id);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	onQuestionAnswer(id, answers) {
		const pending = this.pending;
		if (!pending || pending.id !== id) return;
		const parsed = parseAnswers(answers);
		if (!parsed) {
			this.broadcast({
				type: "question-error",
				id,
				text: "答案无效"
			});
			return;
		}
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id
		});
		console.error("dsh-orb: question answered");
		pending.resolve(parsed);
	}
	onQuestionCancel(id) {
		this.failQuestion("the user cancelled ask_user_question", "ASK_CANCELLED", id);
	}
	/** The ball is gone, so the main window can answer. Abort and cancel still reject. */
	handQuestionBack() {
		const pending = this.pending;
		if (!pending) return;
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id: pending.id
		});
		console.error("dsh-orb: question returned to the main window");
		pending.next().then(pending.resolve, pending.reject);
	}
	failQuestion(message, code, id = this.pending?.id) {
		const pending = this.pending;
		if (!pending || pending.id !== id) return;
		this.pending = void 0;
		this.questionBody = void 0;
		this.broadcast({
			type: "question-clear",
			id
		});
		console.error(`dsh-orb: question ${code}`);
		pending.reject(questionError(message, code));
	}
	questionPayload(id) {
		return {
			type: "question",
			id,
			questions: this.questionBody ?? []
		};
	}
	broadcast(message) {
		for (const socket of this.sockets) this.send(socket, message);
	}
	send(socket, message) {
		try {
			socket.write(`${JSON.stringify(message)}\n`);
		} catch {
			socket.destroy();
		}
	}
	launch() {
		if (this.halted || !this.binary) return;
		const generation = this.generation;
		const userData = this.userData || helperDataDirectory(this.store.dir);
		const env = {
			...process.env,
			DSH_ORB_TOKEN: this.token,
			DSH_ORB_SOCKET: `127.0.0.1:${this.port}`,
			DSH_ORB_WEB_PORT: String(this.ctx.webServer.port),
			...Object.keys(this.appearance).length > 0 ? { DSH_ORB_APPEARANCE: JSON.stringify(this.appearance) } : {}
		};
		delete env.ELECTRON_RUN_AS_NODE;
		const child = spawn(this.binary, [`--user-data-dir=${userData}`, helperMain()], {
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		console.error(`dsh-orb: helper started pid ${child.pid ?? "unknown"}`);
		setTimeout(() => {
			if (this.child === child) this.failures = 0;
		}, 6e4).unref();
		const token = this.token;
		const log = (chunk) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim() || line.includes(token) || /token=|api[_-]?key|authorization/i.test(line)) continue;
				console.error(`dsh-orb helper: ${line}`);
			}
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", log);
		child.stderr?.on("data", log);
		let settled = false;
		const fail = (reason) => {
			if (settled || this.halted || generation !== this.generation) return;
			settled = true;
			if (this.child === child) this.child = void 0;
			this.failures += 1;
			if (this.failures > 3) {
				this.helperError = "helper-exited";
				console.error("dsh-orb: helper exited too many times; ball stays hidden");
				return;
			}
			console.error(`dsh-orb: helper exited (${reason}); retry ${this.failures}`);
			this.retry = setTimeout(() => this.launch(), 500);
			this.retry.unref();
		};
		child.once("error", (error) => fail(error.message));
		child.once("exit", (code, signal) => fail(String(code ?? signal)));
	}
	killChild() {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		const pid = child.pid;
		if (pid === void 0) return;
		setTimeout(() => {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}, 1e3).unref();
	}
	/** True when the helper presented this socket token. */
	helperAuthorized(token) {
		return tokensMatch(token, this.token);
	}
	/** Push permission, both models, the catalog, and the avatar version to the ball. */
	async publishChrome() {
		const models = this.store.models();
		let catalog = { groups: [] };
		try {
			catalog = normalizeCatalog(await this.ctx.sessionController.modelCatalog());
		} catch (error) {
			console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.broadcast({
			type: "permission",
			preset: this.store.permission()
		});
		this.broadcast({
			type: "chrome",
			overlay: models.overlay,
			background: models.background,
			millifractionEnabled: this.store.millifractionEnabled(),
			openMain: isDesktopHost(),
			catalog
		});
		this.broadcast({
			type: "avatar",
			version: Math.trunc(this.store.avatarVersion())
		});
	}
	/**
	* Store the theme/locale preferences the ball mirrors and push them to a
	* connected helper. The raw preference travels; the helper resolves
	* `system` and an absent locale against its own environment.
	*/
	setAppearance(appearance) {
		const next = {
			...appearance.theme === void 0 ? {} : { theme: appearance.theme },
			...appearance.locale === void 0 ? {} : { locale: appearance.locale }
		};
		this.appearance = next;
		if (Object.keys(next).length > 0) this.broadcast({
			type: "appearance",
			...next
		});
	}
	async setOverlayModel(selection) {
		this.store.setOverlay(selection);
		if (this.sessionId) await this.applyOverlayQuiet(this.sessionId);
		await this.publishChrome();
	}
	async setBackgroundModel(selection) {
		this.store.setBackground(selection);
		await this.publishChrome();
	}
	async setSelectionEnabled(enabled) {
		this.store.setSelectionEnabled(enabled);
		this.selection.sync();
		await this.publishChrome();
	}
	async setMillifractionEnabled(enabled) {
		if (this.store.millifractionEnabled() === enabled) return;
		this.store.setMillifractionEnabled(enabled);
		if (this.sessionId) await this.newSession();
		else await this.publishChrome();
	}
	async setBallEnabled(enabled) {
		this.store.setBallEnabled(enabled);
		if (process.platform === "linux") return;
		if (enabled) {
			this.start().catch((error) => {
				console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
			});
			return;
		}
		this.halt();
	}
	onControl(message) {
		const record = asRecord(message);
		if (!record || typeof record.type !== "string") return;
		if (record.type === "overlay-ack" && typeof record.id === "string") {
			this.overlayWaiters.get(record.id)?.();
			this.overlayWaiters.delete(record.id);
			return;
		}
		if (record.type === "selection-action" && typeof record.action === "string") {
			this.onSelectionAction(record);
			return;
		}
		if (record.type === "history") {
			this.run("history", () => this.sendHistory());
			return;
		}
		if (record.type === "open" && typeof record.sessionId === "string") {
			this.run("open", () => this.openSession(record.sessionId));
			return;
		}
		if (record.type === "new") {
			this.run("new", () => this.newSession());
			return;
		}
		const preset = record.preset;
		if (record.type === "permission" && isPermissionPreset(preset)) {
			this.run("permission", () => this.setPermission(preset));
			return;
		}
		if (record.type === "stop") {
			this.run("stop", () => this.stopTurn());
			return;
		}
		if (record.type === "menu") {
			this.run("menu", () => this.publishChrome());
			return;
		}
		const selection = record.selection;
		if (record.type === "set-overlay" && isAgentModelSelection(selection)) {
			this.run("overlay-model", () => this.setOverlayModel(selection));
			return;
		}
		if (record.type === "set-background" && isAgentModelSelection(selection)) {
			this.run("background-model", () => this.setBackgroundModel(selection));
			return;
		}
		if (record.type === "set-selection" && typeof record.enabled === "boolean") {
			this.run("selection", () => this.setSelectionEnabled(record.enabled === true));
			return;
		}
		if (record.type === "set-millifraction" && typeof record.enabled === "boolean") {
			this.run("millifraction", () => this.setMillifractionEnabled(record.enabled === true));
			return;
		}
		if (record.type === "disable") {
			this.run("disable", () => this.setBallEnabled(false));
			return;
		}
		if (record.type === "open-main") {
			this.run("open-main", () => this.openMain());
			return;
		}
		if (record.type === "tcc") {
			this.broadcast({
				type: "tcc",
				status: this.tcc.status()
			});
			return;
		}
		if (record.type === "tcc-open" && isTccRight(record.right)) {
			const right = record.right;
			this.run("tcc", async () => {
				await this.tcc.open(right);
				this.broadcast({
					type: "tcc",
					status: this.tcc.status()
				});
			});
		}
	}
	/** Keep a failed ball action inside this plugin. An unhandled rejection exits the official host. */
	run(label, task) {
		task().catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh-orb: ${label} failed: ${message}`);
			this.status(message);
		});
	}
	async setPermission(preset) {
		this.store.setPermission(preset);
		if (this.sessionId) pinSessionId(this.ctx, this.sessionId, preset);
		await this.publishChrome();
	}
	async stopTurn() {
		const sessionId = this.sessionId;
		if (!sessionId || !this.turnRunning) return;
		try {
			await this.ctx.sessionController.cancel({ sessionId });
		} catch (error) {
			console.error(`dsh-orb: cancel failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.drain();
		this.finishTurn();
	}
	async newSession() {
		this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED");
		const session = await this.ctx.sessionController.create({
			workspaceId: await this.workspaceId(),
			agentPreset: "computer-use"
		});
		await this.adopt(session.sessionId);
		this.resetTranscript();
		await this.publishChrome();
	}
	async openSession(sessionId) {
		if (!sessionId.startsWith("session-") || sessionId.length > 80) return;
		const row = (await this.historyRecords()).find((item) => item.sessionId === sessionId);
		if (!row) return;
		this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED");
		const session = await this.ctx.sessionController.create({
			workspaceId: await this.workspaceId(),
			agentPreset: "computer-use",
			sessionId
		});
		await this.adopt(session.sessionId);
		this.resetTranscript();
		this.replaying = true;
		this.drain();
		this.replaying = false;
		if (row.running) {
			this.turnRunning = true;
			this.selection.setSessionRunning(true);
			this.broadcast({
				type: "turn",
				running: true
			});
			this.watch();
		}
	}
	async sendHistory() {
		const current = this.sessionId;
		const items = (await this.historyRecords()).slice(0, 40).map((row) => ({
			sessionId: row.sessionId,
			title: row.title,
			current: row.sessionId === current
		}));
		this.broadcast({
			type: "history",
			items
		});
	}
	async historyRecords() {
		try {
			const listed = await this.ctx.sessionController.list({}, AbortSignal.timeout(15e3));
			const rows = Array.isArray(listed) ? listed : listed.items ?? [];
			const orb = resolve(dshHomePath("dsh_orb"));
			const items = [];
			for (const row of rows) {
				const record = asRecord(row);
				if (!record || !isHistoryRow(record, orb) || typeof record.sessionId !== "string") continue;
				const title = projection(record, "title");
				items.push({
					sessionId: record.sessionId,
					title: typeof title === "string" ? title.slice(0, 200) : "",
					running: record.running === true
				});
			}
			return items;
		} catch (error) {
			console.error(`dsh-orb: history failed: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}
	resetTranscript() {
		this.blocks.clear();
		this.blockOrder.length = 0;
		this.watermark = 0;
		this.turnRunning = false;
		this.attemptPositions.clear();
		this.lastAttemptByStep.clear();
		this.stepBlocks.clear();
		this.liveStep = void 0;
		this.responseKeys = [];
		this.clearDirty();
		this.selection.setSessionRunning(false);
		this.stopWatch();
		this.broadcast({ type: "reset" });
		this.broadcast({
			type: "turn",
			running: false
		});
	}
	onSelectionAction(record) {
		if (record.action === "search") this.selection.search();
		else if (record.action === "translate") this.selection.translate();
		else if (record.action === "send") this.selection.sendToAgent();
		else if (record.action === "language" && (record.language === "zh" || record.language === "en")) this.selection.setLanguage(record.language);
	}
	waitAck(message, signal) {
		if (this.sockets.size === 0) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (abort) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.overlayWaiters.delete(message.id);
				if (abort) reject(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("dsh-orb: overlay ack aborted"));
				else resolve();
			};
			const timer = setTimeout(() => {
				finish(false);
			}, 1e3);
			timer.unref();
			const onAbort = () => {
				finish(true);
			};
			if (signal?.aborted) {
				finish(true);
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.overlayWaiters.set(message.id, () => {
				finish(false);
			});
			this.broadcast(message);
		});
	}
	async applyOverlayQuiet(sessionId) {
		const selection = this.store.models().overlay;
		try {
			await selectModelKeepDefault(this.ctx, {
				sessionId,
				provider: selection.provider,
				model: selection.model,
				...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
			});
		} catch (error) {
			console.error(`dsh-orb: overlay model failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async openMain() {
		if (!isDesktopHost()) return;
		await openMainWindow(this.ctx);
	}
};
/** Per-profile Chromium data so desktop and `dsh web` do not share one lock. */
function helperDataDirectory(profileDir) {
	const id = createHash("sha256").update(profileDir).digest("hex").slice(0, 16);
	return dshHomePath("dsh-orb", "helper-data", id);
}
function isPrompt(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	return record.type === "prompt" && typeof record.text === "string" && record.text.length <= 8e3;
}
async function readSavedSession(file) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (typeof parsed.sessionId === "string" && parsed.sessionId.startsWith("session-")) return parsed.sessionId;
	} catch {}
}
function toolName(data) {
	if (typeof data !== "object" || data === null) return "";
	const name = data.name;
	return typeof name === "string" ? name : "";
}
function toolArguments(data) {
	if (typeof data !== "object" || data === null) return "";
	const args = data.arguments;
	return typeof args === "string" ? args : "";
}
function callIdValueOf(data) {
	const record = asRecord(data);
	if (!record) return "";
	const id = record.toolCallId ?? record.callId ?? record.id;
	return typeof id === "string" ? id : "";
}
/** Flatten result content blocks to display text (tool-call-model resultText). */
function resultText(content, error) {
	const parts = [];
	if (Array.isArray(content)) for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "text" && typeof record.text === "string") parts.push(record.text);
		else parts.push(JSON.stringify(block, null, 2));
	}
	if (parts.length === 0 && error !== void 0) parts.push(`${typeof error.name === "string" ? error.name : "Error"}: ${typeof error.code === "string" ? error.code : "unknown"}`);
	return parts.join("\n");
}
function jsonText(value) {
	if (value === void 0 || value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
function isQuestionAnswer(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	return record.type === "question-answer" && typeof record.id === "string";
}
function isQuestionCancel(message) {
	if (typeof message !== "object" || message === null) return false;
	const record = message;
	return record.type === "question-cancel" && typeof record.id === "string";
}
function isHistoryRow(record, orb) {
	if (record.origin === "subagent") return false;
	if (typeof record.cwd !== "string" || resolve(record.cwd) !== orb) return false;
	const preset = projection(record, "agentPreset");
	return preset === void 0 || preset === "computer-use";
}
function projection(record, key) {
	return asRecord(asRecord(record.projections)?.values)?.[key];
}
function userText(data) {
	const record = asRecord(data);
	if (!record) return "";
	const source = asRecord(record.source);
	if (source && source.kind !== void 0 && source.kind !== "user") return "";
	return textOf(record.content);
}
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) {
		const block = asRecord(part);
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function numberOf(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** Validate the provider token-usage payload of an `assistant/message` event. */
function readUsage(value) {
	const record = asRecord(value);
	if (!record) return void 0;
	const count = (raw) => {
		const number = typeof raw === "number" ? raw : NaN;
		return Number.isFinite(number) && number >= 0 ? number : void 0;
	};
	const inputTokens = count(record.inputTokens);
	const outputTokens = count(record.outputTokens);
	if (inputTokens === void 0 || outputTokens === void 0) return void 0;
	return {
		inputTokens,
		outputTokens,
		...count(record.totalTokens) === void 0 ? {} : { totalTokens: count(record.totalTokens) },
		...count(record.cacheReadTokens) === void 0 ? {} : { cacheReadTokens: count(record.cacheReadTokens) },
		...count(record.cacheWriteTokens) === void 0 ? {} : { cacheWriteTokens: count(record.cacheWriteTokens) },
		...count(record.reasoningTokens) === void 0 ? {} : { reasoningTokens: count(record.reasoningTokens) }
	};
}
function partKind(part) {
	if (!part) return void 0;
	if (part.type === "text") return "assistant";
	if (part.type === "reasoning" || part.type === "thinking") return "reasoning";
	if (part.type === "tool-call" || part.type === "tool_use") return "tool";
}
function callId(data) {
	const record = asRecord(data);
	if (!record) return "";
	if (typeof record.id === "string") return record.id;
	if (typeof record.callId === "string") return record.callId;
	if (typeof record.toolCallId === "string") return record.toolCallId;
	const call = asRecord(record.call);
	return typeof call?.id === "string" ? call.id : "";
}
function bounded(value, max) {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : "";
}
function sanitizeQuestions(value) {
	if (!Array.isArray(value)) return [];
	const questions = [];
	for (const item of value.slice(0, 20)) {
		const record = asRecord(item);
		if (!record) continue;
		const id = bounded(record.id, 200);
		const question = bounded(record.question, 4e3);
		if (!id || !question) continue;
		const options = [];
		if (Array.isArray(record.options)) for (const option of record.options.slice(0, 20)) {
			const entry = asRecord(option);
			const label = entry ? bounded(entry.label, 500) : "";
			if (!label) continue;
			const description = entry ? bounded(entry.description, 2e3) : "";
			options.push(description ? {
				label,
				description
			} : { label });
		}
		const detail = bounded(record.detail, 8e3);
		const header = bounded(record.header, 200);
		questions.push({
			id,
			question,
			...detail ? { detail } : {},
			...header ? { header } : {},
			...options.length > 0 ? { options } : {},
			...record.multiSelect === true ? { multiSelect: true } : {}
		});
	}
	return questions;
}
function parseAnswers(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > 20) return void 0;
	const answers = [];
	for (const item of value) {
		const record = asRecord(item);
		if (!record || typeof record.id !== "string" || record.id.length > 200) return void 0;
		if (!Array.isArray(record.selected) || record.selected.length > 20) return void 0;
		const selected = [];
		for (const label of record.selected) {
			if (typeof label !== "string" || label.length > 4e3) return void 0;
			selected.push(label);
		}
		if (record.custom !== void 0 && (typeof record.custom !== "string" || record.custom.length > 4e3)) return void 0;
		const custom = typeof record.custom === "string" ? record.custom : "";
		answers.push({
			id: record.id,
			selected,
			...custom ? { custom } : {}
		});
	}
	return { answers };
}
function questionError(message, code) {
	const error = new Error(message);
	error.name = "UserQuestionError";
	return Object.assign(error, { code });
}
function clip(text, max) {
	return text.length <= max ? text : text.slice(0, max);
}
//#endregion
//#region src/index.ts
/**
* Host-side Orb plugin.
* The ball is a separate Electron process. This plugin owns the socket, the preferences, and the Computer Use session.
*/
/** Cordis plugin name. */
const name = "orb-host";
/** Official services this plugin reads. Missing ones keep it pending. */
const inject = [
	"webServer",
	"connection",
	"sessionController",
	"workspaceController",
	"sessions",
	"agentDefaultModel"
];
/**
* Register preferences, Computer Use services, and settings routes, then start the ball.
* Linux never starts the helper. `autoStart: false` and `ball-enabled.json` leave Computer Use in the main window.
* @param ctx - host services named in {@link inject}.
* @param config - patch config. `autoStart: false` skips the helper until settings turn it back on.
*/
function apply(ctx, config = {}) {
	logWebPort(ctx);
	const store = new ProfileStore(profileDirectory(ctx));
	const tcc = new TccMonitor();
	const runtime = new OrbRuntime(ctx, store, { tcc });
	installOrbServices(ctx, store);
	console.error(`dsh-orb: profile ${store.dir}`);
	ctx.effect(() => {
		const detachQuestions = runtime.attachQuestions();
		const detachPermissions = watchOrbPermissions(ctx, store);
		const detachRoutes = registerOrbRoutes({
			ctx,
			store,
			tcc,
			control: runtime
		});
		const detachAppearance = watchAppearance(ctx, (appearance) => {
			runtime.setAppearance(appearance);
		});
		if (process.platform !== "linux" && config.autoStart !== false && store.ballEnabled()) runtime.start().catch((error) => {
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		});
		return () => {
			detachQuestions();
			detachPermissions();
			detachRoutes();
			detachAppearance();
			runtime.halt();
		};
	});
}
/** Print the loopback port. The authenticated URL contains credentials, so it is never logged. */
function logWebPort(ctx) {
	const port = ctx.webServer.port;
	try {
		const authed = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`);
		const hostname = new URL(authed).hostname;
		if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") console.error("dsh-orb: authenticated URL is not loopback");
	} catch {
		console.error("dsh-orb: authenticated URL is unavailable");
	}
	console.error(`dsh-orb: host web port ${port}`);
}
//#endregion
export { apply, inject, name };
