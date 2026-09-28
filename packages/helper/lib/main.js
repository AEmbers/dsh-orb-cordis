import { BrowserWindow, app, ipcMain, screen } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
//#region src/page.ts
/** Minimal ball page. One transcript, one input, and a draggable circle. */
const ballHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>dsh-orb</title>
  <style>
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #root { position: relative; width: 100%; height: 100%; }
    #panel { display: none; position: absolute; left: 10px; right: 10px; top: 10px; bottom: 78px; flex-direction: column; border-radius: 16px; background: rgba(18, 22, 28, 0.94); color: #f4f7fb; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28); overflow: hidden; }
    body.expanded #panel { display: flex; }
    #who { padding: 10px 12px 0; font-size: 12px; color: #9aa6b2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #log { flex: 1; overflow: auto; padding: 8px 12px; font-size: 13px; line-height: 1.45; }
    .user { margin: 8px 0; color: #d6e6ff; white-space: pre-wrap; }
    .assistant { margin: 8px 0; white-space: pre-wrap; }
    .tool { margin: 8px 0; color: #8fd6b5; }
    #status { padding: 0 12px 8px; min-height: 16px; font-size: 12px; color: #9aa6b2; }
    form { display: flex; gap: 8px; padding: 0 12px 12px; }
    input { flex: 1; border: 0; border-radius: 10px; padding: 8px 10px; background: #0f141b; color: white; }
    button.send { border: 0; border-radius: 10px; background: #1d6fe8; color: white; padding: 0 12px; }
    button.send:disabled, input:disabled { opacity: 0.6; }
    #ball { position: absolute; right: 8px; bottom: 8px; width: 56px; height: 56px; border: 0; border-radius: 50%; padding: 0; background: radial-gradient(circle at 35% 30%, #b9e4ff, #1d6fe8 58%, #0b2a55); box-shadow: 0 8px 18px rgba(0, 0, 0, 0.35); cursor: grab; }
    #ball:focus-visible { outline: 2px solid white; outline-offset: 2px; }
  </style>
</head>
<body>
  <div id="root">
    <div id="panel">
      <div id="who">Orb</div>
      <div id="log"></div>
      <div id="status"></div>
      <form id="form">
        <input id="text" maxlength="4000" placeholder="让 Computer Use 操作这台电脑" autocomplete="off">
        <button class="send" type="submit">发送</button>
      </form>
    </div>
    <button id="ball" type="button" aria-label="悬浮球"></button>
  </div>
  <script>
    const orb = window.dshOrb
    const who = document.getElementById('who')
    const log = document.getElementById('log')
    const status = document.getElementById('status')
    const form = document.getElementById('form')
    const input = document.getElementById('text')
    const ball = document.getElementById('ball')
    let expanded = false
    let dragging = false
    let moved = false
    let lastX = 0
    let lastY = 0

    function setExpanded(next) {
      expanded = next
      document.body.classList.toggle('expanded', expanded)
      orb.setExpanded(expanded)
      if (expanded) input.focus()
    }

    function addLine(role, text) {
      const row = document.createElement('div')
      row.className = role
      row.textContent = role === 'tool' ? '工具 ' + text : text
      log.appendChild(row)
      log.scrollTop = log.scrollHeight
    }

    orb.onSession((id) => { who.textContent = 'Orb · ' + id })
    orb.session().then((id) => { if (id) who.textContent = 'Orb · ' + id })
    orb.onLine((line) => {
      if (!line || typeof line.text !== 'string') return
      if (line.role === 'status') {
        status.textContent = line.text
        const busy = line.text === '正在执行'
        input.disabled = busy
        form.querySelector('button').disabled = busy
        return
      }
      addLine(line.role, line.text)
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = input.value.trim()
      if (!text || input.disabled) return
      input.value = ''
      orb.send(text)
    })

    ball.addEventListener('pointerdown', (event) => {
      dragging = true
      moved = false
      lastX = event.screenX
      lastY = event.screenY
      ball.setPointerCapture(event.pointerId)
    })
    ball.addEventListener('pointermove', (event) => {
      if (!dragging) return
      const dx = event.screenX - lastX
      const dy = event.screenY - lastY
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
      lastX = event.screenX
      lastY = event.screenY
      if (moved) orb.moveBy(dx, dy)
    })
    ball.addEventListener('pointerup', () => {
      dragging = false
      if (!moved) setExpanded(!expanded)
    })
  <\/script>
</body>
</html>
`;
//#endregion
//#region src/main.ts
/**
* Minimal floating ball. The official dsh process owns the session; this process only draws and forwards one socket.
*/
const socketAddress = process.env.DSH_ORB_SOCKET ?? "";
const token = process.env.DSH_ORB_TOKEN ?? "";
process.title = "dsh-orb-helper";
if (!socketAddress || !token) {
	console.error("dsh-orb helper: socket environment is missing");
	process.exit(1);
}
if (process.platform === "darwin") app.setActivationPolicy?.("accessory");
let win;
let live;
let sessionId = null;
let quitting = false;
let buffer = "";
app.on("before-quit", () => {
	quitting = true;
	live?.destroy();
});
app.on("window-all-closed", () => {
	app.quit();
});
app.whenReady().then(async () => {
	if (process.platform === "darwin") app.dock?.hide();
	const userData = app.getPath("userData");
	await mkdir(userData, { recursive: true });
	const pagePath = join(userData, "ball.html");
	await writeFile(pagePath, ballHtml);
	win = openWindow();
	win.webContents.on("did-finish-load", () => {
		if (win && !win.isVisible()) win.showInactive();
	});
	await win.loadFile(pagePath);
	connect(0);
});
ipcMain.handle("orb:session", () => sessionId);
ipcMain.on("orb:prompt", (_event, text) => {
	if (typeof text !== "string" || !live) return;
	live.write(`${JSON.stringify({
		type: "prompt",
		text
	})}\n`);
});
ipcMain.on("orb:move-by", (_event, delta) => {
	if (!win || !isDelta(delta)) return;
	const [x, y] = win.getPosition();
	win.setPosition(Math.round(x + delta.dx), Math.round(y + delta.dy));
});
ipcMain.on("orb:expand", (_event, expanded) => {
	if (!win || typeof expanded !== "boolean") return;
	const [x, y] = win.getPosition();
	const [width, height] = win.getSize();
	const right = x + width;
	const bottom = y + height;
	const nextWidth = expanded ? 340 : 72;
	const nextHeight = expanded ? 480 : 72;
	win.setBounds({
		x: Math.round(right - nextWidth),
		y: Math.round(bottom - nextHeight),
		width: nextWidth,
		height: nextHeight
	});
});
function openWindow() {
	const area = screen.getPrimaryDisplay().workArea;
	const width = 72;
	const height = 72;
	const created = new BrowserWindow({
		title: "dsh-orb",
		x: area.x + area.width - width,
		y: area.y + Math.round((area.height - height) / 2),
		width,
		height,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		movable: true,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		hasShadow: false,
		focusable: true,
		show: false,
		backgroundColor: "#00000000",
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			preload: fileURLToPath(new URL("../preload.cjs", import.meta.url)),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	created.setContentProtection(true);
	created.setAlwaysOnTop(true, "screen-saver");
	created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	created.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
	created.once("ready-to-show", () => {
		created.showInactive();
		created.setContentProtection(true);
		const [x, y] = created.getPosition();
		const [width, height] = created.getSize();
		console.error(`dsh-orb helper: ball ${x},${y} ${width}x${height}`);
	});
	return created;
}
function connect(attempt) {
	if (quitting) return;
	const colon = socketAddress.lastIndexOf(":");
	const host = socketAddress.slice(0, colon);
	const port = Number(socketAddress.slice(colon + 1));
	const socket = createConnection({
		host,
		port
	});
	socket.setEncoding("utf8");
	let opened = false;
	socket.on("connect", () => {
		opened = true;
		live = socket;
		buffer = "";
		socket.write(`${JSON.stringify({
			type: "hello",
			token
		})}\n`);
	});
	socket.on("data", (chunk) => {
		buffer += chunk;
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";
		for (const part of parts) {
			if (!part.trim()) continue;
			let message;
			try {
				message = JSON.parse(part);
			} catch {
				continue;
			}
			deliver(message);
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		if (live === socket) live = void 0;
		if (quitting) return;
		if (opened) {
			app.quit();
			return;
		}
		if (attempt >= 30) {
			console.error("dsh-orb helper: host socket did not open");
			app.exit(1);
			return;
		}
		setTimeout(() => connect(attempt + 1), 300);
	});
}
function deliver(message) {
	if (typeof message !== "object" || message === null || !win) return;
	const record = message;
	if (record.type === "session" && typeof record.sessionId === "string") {
		sessionId = record.sessionId;
		win.webContents.send("orb:session", sessionId);
		return;
	}
	if (record.type === "line" && typeof record.role === "string" && typeof record.text === "string") win.webContents.send("orb:line", {
		role: record.role,
		text: record.text
	});
}
function isDelta(value) {
	if (typeof value !== "object" || value === null) return false;
	const delta = value;
	return typeof delta.dx === "number" && typeof delta.dy === "number" && Number.isFinite(delta.dx) && Number.isFinite(delta.dy) && Math.abs(delta.dx) <= 1e4 && Math.abs(delta.dy) <= 1e4;
}
//#endregion
export {};
