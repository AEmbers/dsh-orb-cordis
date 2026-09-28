import { BrowserWindow, app, ipcMain, screen } from "electron";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
const PANEL_SIZE = {
	width: 320,
	height: 420
};
const PANEL_WINDOW_SIZE = {
	width: PANEL_SIZE.width + 24,
	height: PANEL_SIZE.height + 24
};
const BELOW_CENTER = .08;
const DOCK_OVERLAP = Math.round(72 / 5);
const DOCK_DRAG_OFF = Math.round(24);
function clamp(value, min, max) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
function collapsedWindowBounds(ball) {
	return {
		x: ball.x - 12,
		y: ball.y - 12,
		width: 96,
		height: 96
	};
}
function isCollapsed(bounds) {
	return bounds.width <= 96 && bounds.height <= 96;
}
function clampWindowOrigin(value, workOrigin, workSize, windowSize) {
	return clamp(value, workOrigin - 12, workOrigin + workSize - windowSize + 12);
}
/** Which left or right display edge the ball already overlaps by about one fifth of its width. */
function dockSideForBallOrigin(ball, bounds) {
	const leftOverlap = bounds.x - ball.x;
	const rightOverlap = ball.x + 72 - (bounds.x + bounds.width);
	if (leftOverlap >= DOCK_OVERLAP && leftOverlap >= rightOverlap) return "left";
	if (rightOverlap >= DOCK_OVERLAP) return "right";
}
/** Hittable strip for a docked tab, flush with a display edge. */
function dockedTabBounds(side, ballY, bounds) {
	const y = clamp(Math.round(ballY - 8), bounds.y, bounds.y + bounds.height - 88);
	return {
		x: side === "left" ? bounds.x : bounds.x + bounds.width - 34,
		y,
		width: 34,
		height: 88
	};
}
/** Panel growth that keeps the expanded overlay on the open side of the ball. */
function expandDirection(ball, workArea) {
	return {
		horizontal: ball.x + 36 - workArea.x > workArea.width / 2 ? "left" : "right",
		vertical: ball.y - workArea.y < PANEL_SIZE.height - 72 ? "down" : "up"
	};
}
/** Ball top-left recovered from an expanded window and its growth direction. */
function ballOriginFromWindow(bounds, direction) {
	return {
		x: direction.horizontal === "left" ? bounds.x + bounds.width - 12 - 72 : bounds.x + 12,
		y: direction.vertical === "up" ? bounds.y + bounds.height - 12 - 72 : bounds.y + 12
	};
}
/** Keep a 72px ball fully inside a work area. */
function clampedBallOrigin(ball, workArea) {
	return {
		x: clamp(ball.x, workArea.x, workArea.x + workArea.width - 72),
		y: clamp(ball.y, workArea.y, workArea.y + workArea.height - 72)
	};
}
/** Collapsed origin on the work-area right edge, slightly below vertical center. */
function defaultFloatingBallOrigin(workArea) {
	const x = workArea.x + workArea.width - 72;
	const y = workArea.y + (workArea.height - 72) / 2 + workArea.height * BELOW_CENTER;
	return clampedBallOrigin({
		x: Math.round(x),
		y: Math.round(y)
	}, workArea);
}
function overlayBoundsFromBall(ball, direction) {
	return {
		x: direction.horizontal === "left" ? ball.x - (PANEL_SIZE.width - 72) - 12 : ball.x - 12,
		y: direction.vertical === "up" ? ball.y - (PANEL_SIZE.height - 72) - 12 : ball.y - 12,
		width: PANEL_WINDOW_SIZE.width,
		height: PANEL_WINDOW_SIZE.height
	};
}
function expandedOverlayBounds(ball, workArea) {
	const direction = expandDirection(ball, workArea);
	const unclamped = overlayBoundsFromBall(ball, direction);
	return {
		x: clampWindowOrigin(unclamped.x, workArea.x, workArea.width, unclamped.width),
		y: clampWindowOrigin(unclamped.y, workArea.y, workArea.height, unclamped.height),
		width: unclamped.width,
		height: unclamped.height,
		...direction
	};
}
function clampBallY(ballY, bounds) {
	return clamp(Math.round(ballY), bounds.y, bounds.y + bounds.height - 72);
}
function offScreenBallOrigin(side, ballY, bounds) {
	const y = clampBallY(ballY, bounds);
	return {
		x: side === "left" ? bounds.x - 72 - 2 : bounds.x + bounds.width + 2,
		y
	};
}
function insideBallOrigin(side, ballY, display) {
	return {
		x: side === "left" ? display.bounds.x + 5 : display.bounds.x + display.bounds.width - 72 - 5,
		y: clamp(Math.round(ballY), display.workArea.y, display.workArea.y + display.workArea.height - 72)
	};
}
function staysDocked(side, cursorX, bounds) {
	if (side === "right") return cursorX >= bounds.x + bounds.width - DOCK_DRAG_OFF;
	return cursorX <= bounds.x + DOCK_DRAG_OFF;
}
function easeInOutCubic(t) {
	return t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
function easeOutCubic(t) {
	return 1 - (1 - t) ** 3;
}
function lerpRect(start, end, t) {
	return {
		x: Math.round(start.x + (end.x - start.x) * t),
		y: Math.round(start.y + (end.y - start.y) * t),
		width: Math.round(start.width + (end.width - start.width) * t),
		height: Math.round(start.height + (end.height - start.height) * t)
	};
}
/** Initial collapsed window, including the transparent chrome around the ball. */
function initialWindowBounds(workArea) {
	return collapsedWindowBounds(defaultFloatingBallOrigin(workArea));
}
/**
* Owns expand direction and dock state for one overlay window.
* Dock is committed on pointer-up, not while the ball is still moving.
*/
var FloatingPlacement = class {
	window;
	displayAt;
	direction = {
		horizontal: "left",
		vertical: "up"
	};
	docked;
	anim = 0;
	constructor(window, displayAt) {
		this.window = window;
		this.displayAt = displayAt;
	}
	/** Resize between the ball and the panel while keeping the ball origin fixed. */
	setExpanded(expanded) {
		const bounds = this.window.getBounds();
		const display = this.displayAt(center(bounds));
		if (expanded) {
			const origin = this.currentBallOrigin(display.workArea);
			this.docked = void 0;
			const next = expandedOverlayBounds(origin, display.workArea);
			this.direction = {
				horizontal: next.horizontal,
				vertical: next.vertical
			};
			this.window.setBounds({
				x: next.x,
				y: next.y,
				width: next.width,
				height: next.height
			});
			return {
				expanded: true,
				...this.direction,
				docked: void 0
			};
		}
		if (this.docked) {
			this.applyTab(this.docked.side, this.docked.y, display.bounds);
			return {
				expanded: false,
				...this.direction,
				docked: this.docked.side
			};
		}
		const origin = clampedBallOrigin(this.currentBallOrigin(display.workArea), display.workArea);
		this.window.setBounds(collapsedWindowBounds(origin));
		return {
			expanded: false,
			...this.direction,
			docked: void 0
		};
	}
	/**
	* Move so the 72px ball origin follows `(x, y)`.
	* A collapsed ball may hang past a display edge. Dock is committed by {@link clamp}.
	*/
	move(x, y, canDock = true) {
		const origin = {
			x: Math.round(x),
			y: Math.round(y)
		};
		if (!isCollapsed(this.window.getBounds()) && this.docked === void 0) {
			const direction = this.direction;
			this.window.setBounds(overlayBoundsFromBall(origin, direction));
			return { docked: void 0 };
		}
		if (!canDock) {
			this.docked = void 0;
			this.anim += 1;
			this.window.setBounds(collapsedWindowBounds(origin));
			return { docked: void 0 };
		}
		const display = this.displayAt(origin);
		if (this.docked && staysDocked(this.docked.side, origin.x, display.bounds)) {
			this.applyTab(this.docked.side, this.docked.y, display.bounds);
			return { docked: this.docked.side };
		}
		this.docked = void 0;
		this.anim += 1;
		this.window.setBounds(collapsedWindowBounds(origin));
		return { docked: void 0 };
	}
	/** Pull a free ball inside the work area, or dock it when it already overlaps a side edge. */
	async clamp(canDock = true) {
		const bounds = this.window.getBounds();
		const display = this.displayAt(center(bounds));
		if (this.docked) {
			this.applyTab(this.docked.side, this.docked.y, display.bounds);
			return { docked: this.docked.side };
		}
		if (isCollapsed(bounds)) {
			const origin = {
				x: bounds.x + 12,
				y: bounds.y + 12
			};
			if (canDock) {
				const side = dockSideForBallOrigin(origin, display.bounds);
				if (side) return this.snap(side, origin.y, display.bounds);
			}
			this.window.setBounds(collapsedWindowBounds(clampedBallOrigin(origin, display.workArea)));
			return { docked: void 0 };
		}
		this.setExpanded(true);
		return { docked: void 0 };
	}
	/** Slide the ball back on screen from a docked tab. */
	async unsnap() {
		if (!this.docked) return { docked: void 0 };
		const display = this.displayAt(center(this.window.getBounds()));
		const start = offScreenBallOrigin(this.docked.side, this.docked.y, display.bounds);
		const end = insideBallOrigin(this.docked.side, this.docked.y, display);
		this.docked = void 0;
		this.window.setBounds(collapsedWindowBounds(start));
		await this.animate(collapsedWindowBounds(end), 300, easeOutCubic);
		return { docked: void 0 };
	}
	currentBallOrigin(workArea) {
		const bounds = this.window.getBounds();
		if (this.docked) return insideBallOrigin(this.docked.side, this.docked.y, this.displayAt(center(bounds)));
		if (isCollapsed(bounds)) return {
			x: bounds.x + 12,
			y: bounds.y + 12
		};
		return ballOriginFromWindow(bounds, this.direction);
	}
	applyTab(side, ballY, bounds) {
		const y = clampBallY(ballY, bounds);
		this.docked = {
			side,
			y
		};
		this.anim += 1;
		this.window.setBounds(dockedTabBounds(side, y, bounds));
	}
	async snap(side, ballY, bounds) {
		const y = clampBallY(ballY, bounds);
		this.docked = {
			side,
			y
		};
		await this.animate(collapsedWindowBounds(offScreenBallOrigin(side, y, bounds)), 250, easeInOutCubic);
		if (!this.docked || this.docked.side !== side) return { docked: this.docked?.side };
		this.window.setBounds(dockedTabBounds(side, y, bounds));
		return { docked: side };
	}
	animate(end, durationMs, ease) {
		const generation = ++this.anim;
		const start = this.window.getBounds();
		if (durationMs <= 0) {
			this.window.setBounds(end);
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const t0 = Date.now();
			const tick = () => {
				if (generation !== this.anim) {
					resolve();
					return;
				}
				const t = Math.min(1, (Date.now() - t0) / durationMs);
				this.window.setBounds(lerpRect(start, end, ease(t)));
				if (t < 1) {
					setTimeout(tick, 16);
					return;
				}
				resolve();
			};
			setTimeout(tick, 16);
		});
	}
};
function center(bounds) {
	return {
		x: bounds.x + bounds.width / 2,
		y: bounds.y + bounds.height / 2
	};
}
//#endregion
//#region src/main.ts
/**
* Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
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
let placement;
let live;
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
	win = openWindow();
	placement = new FloatingPlacement(win, (point) => {
		const display = screen.getDisplayNearestPoint({
			x: Math.round(point.x),
			y: Math.round(point.y)
		});
		return {
			bounds: display.bounds,
			workArea: display.workArea
		};
	});
	win.webContents.on("did-finish-load", () => {
		if (win && !win.isVisible()) win.showInactive();
	});
	await win.loadFile(fileURLToPath(new URL("../assets/floating.html", import.meta.url)));
	connect(0);
});
ipcMain.handle("orb:expand", (_event, expanded) => {
	if (!placement || typeof expanded !== "boolean") return {
		expanded: false,
		horizontal: "left",
		vertical: "up",
		docked: void 0
	};
	return placement.setExpanded(expanded);
});
ipcMain.handle("orb:move", (_event, request) => {
	if (!placement || !isMove(request)) return { docked: void 0 };
	return placement.move(request.x, request.y, request.canDock);
});
ipcMain.handle("orb:clamp", async (_event, canDock) => {
	if (!placement) return { docked: void 0 };
	return placement.clamp(canDock !== false);
});
ipcMain.handle("orb:unsnap", async () => {
	if (!placement) return { docked: void 0 };
	return placement.unsnap();
});
ipcMain.on("orb:prompt", (_event, text) => {
	write({
		type: "prompt",
		text
	});
});
ipcMain.on("orb:question-answer", (_event, payload) => {
	if (typeof payload !== "object" || payload === null) return;
	const record = payload;
	write({
		type: "question-answer",
		id: record.id,
		answers: record.answers
	});
});
ipcMain.on("orb:question-cancel", (_event, id) => {
	write({
		type: "question-cancel",
		id
	});
});
function openWindow() {
	const bounds = initialWindowBounds(screen.getPrimaryDisplay().workArea);
	const created = new BrowserWindow({
		title: "dsh-orb",
		x: bounds.x,
		y: bounds.y,
		width: bounds.width,
		height: bounds.height,
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
		roundedCorners: false,
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
	if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true
	});
	created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	created.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
	created.once("ready-to-show", () => {
		created.showInactive();
		created.setContentProtection(true);
		const shown = created.getBounds();
		console.error(`dsh-orb helper: ball ${shown.x},${shown.y} ${shown.width}x${shown.height}`);
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
	if (record.type === "session") {
		win.webContents.send("orb:session", record.sessionId);
		return;
	}
	if (record.type === "block") {
		win.webContents.send("orb:block", message);
		return;
	}
	if (record.type === "turn") {
		win.webContents.send("orb:turn", message);
		return;
	}
	if (record.type === "status") {
		win.webContents.send("orb:status", record.text);
		return;
	}
	if (record.type === "question") {
		win.webContents.send("orb:question", message);
		return;
	}
	if (record.type === "question-clear") {
		win.webContents.send("orb:question-clear", record.id);
		return;
	}
	if (record.type === "question-error") win.webContents.send("orb:question-error", message);
}
function write(message) {
	if (!live) return;
	live.write(`${JSON.stringify(message)}\n`);
}
function isMove(value) {
	if (typeof value !== "object" || value === null) return false;
	const point = value;
	return typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 1e5 && Math.abs(point.y) <= 1e5 && typeof point.canDock === "boolean";
}
//#endregion
export {};
