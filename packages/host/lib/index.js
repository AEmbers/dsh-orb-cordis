import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
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
//#region src/orb.ts
/**
* NDJSON control plane for the ball, plus the Computer Use session it talks to.
* The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
*/
const require = createRequire(import.meta.url);
/** One host lifetime of the ball: socket, helper process, and one Computer Use session. */
var OrbRuntime = class {
	ctx;
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
	stopped = false;
	sessionId;
	sessionError;
	creating;
	watermark = 0;
	missingLogged = false;
	timer;
	giveUp;
	constructor(ctx) {
		this.ctx = ctx;
	}
	/** Open the socket, prepare a session, and spawn the helper. */
	async start() {
		if (this.stopped) return;
		await this.listen();
		if (this.stopped) return;
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
		if (this.stopped) return;
		await mkdir(dshHomePath("dsh-orb", "helper-data"), { recursive: true });
		this.launch();
	}
	/** Stop the helper and the socket. A later helper exit is not a crash. */
	stop() {
		this.stopped = true;
		this.stopWatch();
		this.failQuestion("ask_user_question was aborted before the user answered", "ASK_ABORTED");
		this.server?.close();
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
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
		for (const key of this.blockOrder) {
			const block = this.blocks.get(key);
			if (block) this.send(socket, block);
		}
		this.send(socket, {
			type: "turn",
			running: this.turnRunning
		});
		if (this.pending) this.send(socket, this.questionPayload(this.pending.id));
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
		const workspace = dshHomePath("dsh_orb");
		await mkdir(workspace, { recursive: true });
		const workspaceId = (await this.ctx.workspaceController.create({ path: workspace })).workspace.workspaceId;
		const saved = await readSavedSession(this.sessionFile);
		try {
			const session = await this.ctx.sessionController.create({
				workspaceId,
				agentPreset: "computer-use",
				...saved ? { sessionId: saved } : {}
			});
			return this.remember(session.sessionId);
		} catch (error) {
			if (!saved) throw error;
			console.error("dsh-orb: saved session cannot be opened; creating a new one");
			await rm(this.sessionFile, { force: true });
			const session = await this.ctx.sessionController.create({
				workspaceId,
				agentPreset: "computer-use"
			});
			return this.remember(session.sessionId);
		}
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
		if (this.stopped || !this.binary) return;
		const userData = dshHomePath("dsh-orb", "helper-data");
		const env = {
			...process.env,
			DSH_ORB_TOKEN: this.token,
			DSH_ORB_SOCKET: `127.0.0.1:${this.port}`
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
				if (!line.trim() || line.includes(token)) continue;
				console.error(`dsh-orb helper: ${line}`);
			}
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", log);
		child.stderr?.on("data", log);
		let settled = false;
		const fail = (reason) => {
			if (settled || this.stopped) return;
			settled = true;
			if (this.child === child) this.child = void 0;
			this.failures += 1;
			if (this.failures > 3) {
				console.error("dsh-orb: helper exited too many times; ball stays hidden");
				return;
			}
			console.error(`dsh-orb: helper exited (${reason}); retry ${this.failures}`);
			setTimeout(() => this.launch(), 500).unref();
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
* The ball is a separate Electron process. This plugin owns the socket and the Computer Use session.
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
* Log the web port, then start the ball unless this is Linux or autoStart is off.
* @param ctx - host services named in {@link inject}.
* @param config - patch config. `autoStart: false` leaves Computer Use in the main window only.
*/
function apply(ctx, config = {}) {
	logWebPort(ctx);
	if (process.platform === "linux" || config.autoStart === false) return;
	const runtime = new OrbRuntime(ctx);
	ctx.effect(() => {
		const detach = runtime.attachQuestions();
		runtime.start().catch((error) => {
			console.error(`dsh-orb: ${error instanceof Error ? error.message : String(error)}`);
		});
		return () => {
			detach();
			runtime.stop();
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
