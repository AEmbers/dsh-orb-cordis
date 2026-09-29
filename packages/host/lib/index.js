import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
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
	modelValue;
	millifractionValue;
	selectionValue;
	selectionLanguage;
	ballValue;
	constructor(dir) {
		this.dir = dir;
		this.permissionValue = readPermission(dir);
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
	setPermission(preset) {
		this.permissionValue = preset;
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
		writeFileSync(join(this.dir, AVATAR_FILE), bytes);
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
	const preset = record(readJson$1(join(dir, PERMISSION_FILE)))?.preset;
	return isPermissionPreset(preset) ? preset : "danger-full-access";
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
	const value = record(readJson$1(join(dir, SELECTION_FILE)));
	const language = value?.translateTargetLanguage === "en" ? "en" : "zh";
	return {
		enabled: typeof value?.enabled === "boolean" ? value.enabled : true,
		language
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
	writeFileSync(file, `${JSON.stringify(value, void 0, 2)}\n`);
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
//#region src/routes.ts
/**
* Settings routes on the official web port.
* The main window calls these with a relative fetch, so the existing login cookie is enough.
* The helper may read only the avatar, and only with its socket token.
*/
const require$1 = createRequire(import.meta.url);
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
		tcc: deps.tcc.status()
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
function defaultAvatarPath() {
	const pkg = require$1.resolve("@dsh-orb/helper/package.json");
	return join(dirname(pkg), "assets", "deepseek-avatar-square.gif");
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
//#region src/electron-runtime.ts
/**
* Locate the generic Electron binary used to open the ball.
* Official DeepSeek Harness is not a usable helper runtime: it has its own app payload and a single-instance lock.
*/
/** Matches the official app's Electron framework and the fork's desktop package. */
const ELECTRON_VERSION = "44.0.0";
const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
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
	const fileName = assetName();
	console.error(`dsh-orb: downloading Electron ${ELECTRON_VERSION} (${fileName})`);
	const expected = expectedHash(await fetchText(`${RELEASE_BASE}/SHASUMS256.txt`), fileName);
	const zipPath = join(tmpdir(), `dsh-orb-${fileName}`);
	try {
		await downloadVerifiedZip(fileName, expected, zipPath);
		await rm(dest, {
			recursive: true,
			force: true
		});
		await mkdir(dest, { recursive: true });
		await extractZip(zipPath, dest);
		if (process.platform === "darwin") await spawnChecked("/usr/bin/xattr", [
			"-dr",
			"com.apple.quarantine",
			dest
		]).catch(() => void 0);
		await chmod(binary, 493);
		await access(binary);
		await writeFile(marker, `${ELECTRON_VERSION}\n`);
	} finally {
		await rm(zipPath, { force: true });
	}
	console.error(`dsh-orb: Electron ${ELECTRON_VERSION} is ready`);
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
function expectedHash(sums, fileName) {
	for (const line of sums.split("\n")) {
		const match = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
		if (match?.[2] === fileName) return match[1].toLowerCase();
	}
	throw new Error(`dsh-orb: ${fileName} is missing from Electron ${ELECTRON_VERSION} checksums`);
}
async function fetchText(url) {
	const { stdout } = await run("curl", [
		"-fsSL",
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
/** Desktop uses the app's `dsh://open` protocol. `dsh web` opens the loopback page. */
function mainWindowTarget(ctx, desktop = isDesktopHost()) {
	if (desktop) return "dsh://open";
	return localPage(ctx);
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
/** Desktop uses the app's `dsh://open` protocol. `dsh web` opens the loopback page. */
async function openMainWindow(ctx) {
	const target = mainWindowTarget(ctx);
	if (target === void 0) return;
	await spawnOpen(target);
}
function localPage(ctx) {
	let url;
	try {
		url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`);
	} catch {
		console.error("dsh-orb: main window URL is unavailable");
		return;
	}
	try {
		const hostname = new URL(url).hostname;
		if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
			console.error("dsh-orb: main window URL is not loopback");
			return;
		}
	} catch {
		console.error("dsh-orb: main window URL is unavailable");
		return;
	}
	return url;
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
//#endregion
//#region src/orb.ts
/**
* NDJSON control plane for the ball, plus the Computer Use session it talks to.
* The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
*/
const require = createRequire(import.meta.url);
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
	child;
	binary = "";
	failures = 0;
	halted = false;
	generation = 0;
	replaying = false;
	workspaceTask;
	retry;
	opening = false;
	sessionId;
	sessionError;
	creating;
	watermark = 0;
	missingLogged = false;
	timer;
	giveUp;
	constructor(ctx, store) {
		this.ctx = ctx;
		this.store = store;
	}
	/** Open the socket, prepare a session, and spawn the helper. A halted ball can start again. */
	async start() {
		if (process.platform === "linux") return;
		if (this.opening || !this.halted && this.server) return;
		this.opening = true;
		this.halted = false;
		this.failures = 0;
		this.generation += 1;
		const generation = this.generation;
		try {
			await this.begin(generation);
		} finally {
			this.opening = false;
		}
	}
	async begin(generation) {
		await this.listen();
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
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		await sessionTask;
		if (this.halted || generation !== this.generation) return;
		await mkdir(dshHomePath("dsh-orb", "helper-data"), { recursive: true });
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
		if (this.retry) clearTimeout(this.retry);
		this.retry = void 0;
		this.stopWatch();
		this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED");
		this.server?.close();
		this.server = void 0;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.buffers.clear();
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
					this.accept(socket);
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
			if (this.sockets.size === 0) this.failQuestion("the floating ball closed before the user answered", "ASK_ABORTED");
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
	accept(socket) {
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
		if (this.pending) this.send(socket, this.questionPayload(this.pending.id));
		this.publishChrome();
	}
	async onPrompt(text) {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.block(`user:${randomUUID()}`, "user", trimmed, false, "set");
		this.turnRunning = true;
		this.broadcast({
			type: "turn",
			running: true
		});
		if (this.sessionError && !this.sessionId) {
			this.turnRunning = false;
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
		if (this.giveUp) clearTimeout(this.giveUp);
		this.giveUp = setTimeout(() => {
			if (this.pending) {
				this.watch();
				return;
			}
			this.status("等待超时");
			this.finishTurn();
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
		try {
			for (const event of session.snapshotEvents()) {
				const seq = Number(event.seq);
				if (seq <= this.watermark) continue;
				this.watermark = seq;
				this.consume(event.type, event.data, seq);
			}
		} catch (error) {
			console.error(`dsh-orb: transcript read failed: ${error instanceof Error ? error.message : String(error)}`);
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
			this.block(id ? `tool:${id}` : existing ?? `tool:${seq}`, "tool", name, false, "set");
			return;
		}
		if (type === "turn/end") this.finishTurn();
	}
	onChunk(data) {
		const record = asRecord(data);
		const chunk = asRecord(record?.chunk);
		if (!record || !chunk) return;
		const turn = numberOf(record.turn);
		const step = numberOf(record.step);
		const index = numberOf(chunk.index);
		const key = `b:${turn}:${step}:${index}`;
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
			this.block(id ? `tool:${id}` : key, "tool", name, true, "set");
			return;
		}
		if (chunk.type === "block-end") this.applyContent(key, chunk.block, turn, step, index, false);
	}
	onAssistant(data) {
		const record = asRecord(data);
		if (!record) return;
		const turn = numberOf(record.turn);
		const step = numberOf(record.step);
		if (Array.isArray(record.stream)) for (const item of record.stream) this.foldStream(item, turn, step);
		const content = asRecord(record.message)?.content;
		if (typeof content === "string") {
			this.block(`b:${turn}:${step}:0`, "assistant", content, false, "set");
			return;
		}
		if (!Array.isArray(content)) return;
		content.forEach((part, index) => {
			this.applyContent(`b:${turn}:${step}:${index}`, part, turn, step, index, false);
		});
	}
	foldStream(item, turn, step) {
		const record = asRecord(item);
		if (!record) return;
		if (record.type === "chunk") {
			this.onChunk({
				turn,
				step,
				chunk: record.chunk
			});
			return;
		}
		const index = numberOf(record.index);
		if (record.type === "text-chunks" || record.type === "reasoning-chunks") {
			const texts = Array.isArray(record.texts) ? record.texts.filter((part) => typeof part === "string").join("") : "";
			if (!texts.trim()) return;
			this.block(`b:${turn}:${step}:${index}`, record.type === "reasoning-chunks" ? "reasoning" : "assistant", texts, false, "set");
			return;
		}
		if (record.type !== "tool-call-chunks") return;
		const name = typeof record.name === "string" ? record.name : "";
		if (!name || this.hasTool(name)) return;
		const id = typeof record.id === "string" ? record.id : "";
		this.block(id ? `tool:${id}` : `b:${turn}:${step}:${index}`, "tool", name, false, "set");
	}
	applyContent(key, part, turn, step, index, running) {
		const block = asRecord(part);
		if (!block) return;
		if ((block.type === "text" || block.type === "reasoning" || block.type === "thinking") && typeof block.text === "string") {
			if (!block.text.trim()) return;
			const kind = block.type === "text" ? "assistant" : "reasoning";
			this.block(key, kind, block.text, running, "set");
			return;
		}
		if (block.type !== "tool-call" && block.type !== "tool_use") return;
		const name = typeof block.name === "string" ? block.name : "";
		if (!name || this.hasTool(name)) return;
		const id = typeof block.id === "string" ? block.id : typeof block.callId === "string" ? block.callId : "";
		this.block(id ? `tool:${id}` : `b:${turn}:${step}:${index}`, "tool", name, running, "set");
	}
	hasTool(name) {
		for (const block of this.blocks.values()) if (block.kind === "tool" && block.text === name) return true;
		return false;
	}
	runningTool(name) {
		for (const key of this.blockOrder) {
			const block = this.blocks.get(key);
			if (block?.kind === "tool" && block.text === name && block.running) return key;
		}
	}
	finishTurn() {
		this.turnRunning = false;
		for (const key of [...this.blockOrder]) {
			const item = this.blocks.get(key);
			if (item?.running) this.block(key, item.kind, item.text, false, "set");
		}
		this.broadcast({
			type: "turn",
			running: false
		});
		this.stopWatch();
		const reply = [...this.blockOrder].reverse().map((key) => this.blocks.get(key)).find((item) => item?.kind === "assistant");
		console.error(`dsh-orb: turn done reply=${reply?.text.length ?? 0}`);
	}
	block(key, kind, text, running, mode) {
		const previous = this.blocks.get(key)?.text ?? "";
		const next = clip(mode === "append" ? `${previous}${text}` : text, 2e4);
		if (!next.trim()) return;
		const message = {
			type: "block",
			key,
			kind,
			text: next,
			running
		};
		if (!this.blocks.has(key)) {
			this.blockOrder.push(key);
			while (this.blockOrder.length > 200) {
				const dropped = this.blockOrder.shift();
				if (dropped) this.blocks.delete(dropped);
			}
		}
		this.blocks.set(key, message);
		this.broadcast(message);
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
				reject
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
		const userData = dshHomePath("dsh-orb", "helper-data");
		const env = {
			...process.env,
			DSH_ORB_TOKEN: this.token,
			DSH_ORB_SOCKET: `127.0.0.1:${this.port}`,
			DSH_ORB_WEB_PORT: String(this.ctx.webServer.port)
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
			selectionEnabled: this.store.selectionEnabled(),
			millifractionEnabled: this.store.millifractionEnabled(),
			catalog
		});
		this.broadcast({
			type: "avatar",
			version: Math.trunc(this.store.avatarVersion())
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
		if (enabled) await this.start();
		else this.halt();
	}
	onControl(message) {
		const record = asRecord(message);
		if (!record || typeof record.type !== "string") return;
		if (record.type === "history") {
			this.sendHistory();
			return;
		}
		if (record.type === "open" && typeof record.sessionId === "string") {
			this.openSession(record.sessionId);
			return;
		}
		if (record.type === "new") {
			this.newSession();
			return;
		}
		if (record.type === "permission" && isPermissionPreset(record.preset)) {
			this.setPermission(record.preset);
			return;
		}
		if (record.type === "stop") {
			this.stopTurn();
			return;
		}
		if (record.type === "menu") {
			this.publishChrome();
			return;
		}
		if (record.type === "set-overlay" && isAgentModelSelection(record.selection)) {
			this.setOverlayModel(record.selection);
			return;
		}
		if (record.type === "set-background" && isAgentModelSelection(record.selection)) {
			this.setBackgroundModel(record.selection);
			return;
		}
		if (record.type === "set-selection" && typeof record.enabled === "boolean") {
			this.setSelectionEnabled(record.enabled);
			return;
		}
		if (record.type === "set-millifraction" && typeof record.enabled === "boolean") {
			this.setMillifractionEnabled(record.enabled);
			return;
		}
		if (record.type === "disable") {
			this.setBallEnabled(false);
			return;
		}
		if (record.type === "open-main") this.openMain();
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
		this.stopWatch();
		this.broadcast({ type: "reset" });
		this.broadcast({
			type: "turn",
			running: false
		});
	}
	async applyOverlayQuiet(sessionId) {
		const selection = this.store.models().overlay;
		try {
			await this.ctx.sessionController.selectModel({
				sessionId,
				provider: selection.provider,
				model: selection.model,
				...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort },
				saveAsDefault: false
			});
		} catch (error) {
			console.error(`dsh-orb: overlay model failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	openMain() {
		openMainWindow(this.ctx).catch(() => {
			console.error("dsh-orb: could not open the main window");
		});
	}
};
function helperMain() {
	const pkg = require.resolve("@dsh-orb/helper/package.json");
	return join(dirname(pkg), "lib", "main.js");
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
	"sessions"
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
	const runtime = new OrbRuntime(ctx, store);
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
		if (process.platform !== "linux" && config.autoStart !== false && store.ballEnabled()) runtime.start().catch((error) => {
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		});
		return () => {
			detachQuestions();
			detachPermissions();
			detachRoutes();
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
