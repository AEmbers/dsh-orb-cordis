import { BrowserWindow, Menu, app, dialog, ipcMain, screen, shell } from "electron";
import { request } from "node:http";
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
function clamp$1(value, min, max) {
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
	return clamp$1(value, workOrigin - 12, workOrigin + workSize - windowSize + 12);
}
/**
* Which outer display edge the ball already overlaps by about one fifth of its width.
* An edge that touches another display is a seam, not a place to dock.
*/
function dockSideForBallOrigin(ball, bounds, displays = []) {
	const leftOverlap = bounds.x - ball.x;
	const rightOverlap = ball.x + 72 - (bounds.x + bounds.width);
	let side;
	if (leftOverlap >= DOCK_OVERLAP && leftOverlap >= rightOverlap) side = "left";
	else if (rightOverlap >= DOCK_OVERLAP) side = "right";
	if (side === void 0 || edgeTouchesDisplay(side, bounds, displays)) return void 0;
	return side;
}
function edgeTouchesDisplay(side, bounds, displays) {
	const edge = side === "left" ? bounds.x : bounds.x + bounds.width;
	for (const other of displays) {
		if (sameRect(other, bounds)) continue;
		const otherEdge = side === "left" ? other.x + other.width : other.x;
		if (Math.abs(otherEdge - edge) > 8) continue;
		const top = Math.max(bounds.y, other.y);
		if (Math.min(bounds.y + bounds.height, other.y + other.height) > top) return true;
	}
	return false;
}
function sameRect(left, right) {
	return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
/** Hittable strip for a docked tab, flush with a display edge. */
function dockedTabBounds(side, ballY, bounds) {
	const y = clamp$1(Math.round(ballY - 8), bounds.y, bounds.y + bounds.height - 88);
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
		x: clamp$1(ball.x, workArea.x, workArea.x + workArea.width - 72),
		y: clamp$1(ball.y, workArea.y, workArea.y + workArea.height - 72)
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
	return clamp$1(Math.round(ballY), bounds.y, bounds.y + bounds.height - 72);
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
		y: clamp$1(Math.round(ballY), display.workArea.y, display.workArea.y + display.workArea.height - 72)
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
	displayBounds;
	direction = {
		horizontal: "left",
		vertical: "up"
	};
	docked;
	anim = 0;
	constructor(window, displayAt, displayBounds = () => []) {
		this.window = window;
		this.displayAt = displayAt;
		this.displayBounds = displayBounds;
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
				const side = dockSideForBallOrigin(origin, display.bounds, this.displayBounds());
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
//#region src/model-menu.ts
const CURRENT_MODEL_MARK = "✓ ";
/** Provider headers, model rows, and effort radios. An empty catalog is one disabled row. */
function modelMenuItems(catalog, current, onSelect, labels) {
	const groups = catalog?.groups ?? [];
	if (groups.length === 0) return [{
		label: labels.empty,
		enabled: false
	}];
	const items = [];
	for (const group of groups) {
		items.push({
			label: group.name,
			enabled: false
		});
		for (const model of group.models) items.push(modelItem(group.id, model, current, onSelect, labels.defaultEffort));
	}
	return items;
}
function modelItem(provider, model, current, onSelect, defaultEffortLabel) {
	const selected = current.provider === provider && current.model === model.id;
	const efforts = effortItems(provider, model, current, onSelect, defaultEffortLabel);
	if (efforts === void 0) return {
		label: model.name,
		type: "checkbox",
		checked: selected,
		click: () => {
			onSelect({
				provider,
				model: model.id
			});
		}
	};
	return {
		label: selected ? `${CURRENT_MODEL_MARK}${model.name}` : model.name,
		submenu: efforts
	};
}
function effortItems(provider, model, current, onSelect, defaultEffortLabel) {
	const reasoning = model.reasoning;
	if (reasoning === void 0) return void 0;
	const selected = current.provider === provider && current.model === model.id;
	const effective = selected ? current.reasoningEffort ?? reasoning.defaultEffort : void 0;
	const items = [];
	if (reasoning.defaultEffort === void 0) items.push({
		label: defaultEffortLabel,
		type: "radio",
		checked: selected && current.reasoningEffort === void 0,
		click: () => {
			onSelect({
				provider,
				model: model.id
			});
		}
	});
	for (const effort of reasoning.efforts) items.push({
		label: effort.name,
		type: "radio",
		checked: effective === effort.id,
		click: () => {
			onSelect({
				provider,
				model: model.id,
				reasoningEffort: effort.id
			});
		}
	});
	return items.length === 0 ? void 0 : items;
}
//#endregion
//#region src/menu.ts
/** Right-click menu for the ball. Model rows come from the host catalog. */
/** Labels and actions for the ball menu. The selection checkbox writes the preference; the host starts and stops the monitor. */
function contextMenuTemplate(state, zh, actions) {
	const labels = {
		empty: zh ? "没有可用的模型。" : "No models available.",
		defaultEffort: zh ? "默认" : "Default"
	};
	return [
		{
			label: zh ? "打开主窗口" : "Open Main Window",
			enabled: state.openMain,
			click: () => {
				actions.openMain();
			}
		},
		{
			label: zh ? "悬浮球 Agent 模型" : "Floating-ball Agent model",
			submenu: modelMenuItems(state.catalog, state.overlay, actions.setOverlay, labels)
		},
		{
			label: zh ? "后台 Agent 模型" : "Background Agent model",
			submenu: modelMenuItems(state.catalog, state.background, actions.setBackground, labels)
		},
		{
			label: zh ? "划词工具栏" : "Selection toolbar",
			type: "checkbox",
			checked: state.selectionEnabled,
			click: (item) => {
				actions.setSelection(item.checked);
			}
		},
		{
			label: zh ? "千分比坐标" : "Millifraction coordinates",
			type: "checkbox",
			checked: state.millifractionEnabled,
			click: (item) => {
				actions.setMillifraction(item.checked);
			}
		},
		{ type: "separator" },
		{
			label: zh ? "停用悬浮球" : "Disable floating ball",
			click: () => {
				actions.disable();
			}
		}
	];
}
//#endregion
//#region src/overlay-geometry.ts
/** Toolbar and observation-frame placement. No Electron import, so tests can run the same math. */
const SELECTION_TOOLBAR_SIZE = {
	width: 280,
	height: 46
};
function clamp(value, min, max) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
/** Toolbar sits just below the mouse-up point and stays inside the work area. */
function selectionToolbarBounds(anchor, size = SELECTION_TOOLBAR_SIZE, workArea) {
	return {
		x: clamp(anchor.x, workArea.x, workArea.x + workArea.width - size.width),
		y: clamp(anchor.y + 8, workArea.y, workArea.y + workArea.height - size.height),
		width: size.width,
		height: size.height
	};
}
/**
* Grow the toolbar window for the language menu.
* The menu hangs below the bar when it fits, and above when it would leave the work area.
*/
function selectionToolbarMenuBounds(barOrigin, contentSize, workArea) {
	const width = Math.max(1, Math.round(contentSize.width));
	const height = Math.max(1, Math.round(contentSize.height));
	const x = clamp(barOrigin.x, workArea.x, workArea.x + workArea.width - width);
	if (barOrigin.y + height <= workArea.y + workArea.height || height <= SELECTION_TOOLBAR_SIZE.height) return {
		x,
		y: clamp(barOrigin.y, workArea.y, workArea.y + workArea.height - height),
		width,
		height
	};
	return {
		x,
		y: clamp(barOrigin.y + SELECTION_TOOLBAR_SIZE.height - height, workArea.y, workArea.y + workArea.height - height),
		width,
		height
	};
}
function intersectRects(area, clip) {
	const x = Math.max(area.x, clip.x);
	const y = Math.max(area.y, clip.y);
	const right = Math.min(area.x + area.width, clip.x + clip.width);
	const bottom = Math.min(area.y + area.height, clip.y + clip.height);
	const width = right - x;
	const height = bottom - y;
	if (width >= 1 && height >= 1) return {
		x,
		y,
		width,
		height
	};
	return {
		x: clamp(area.x, clip.x, clip.x + clip.width - 1),
		y: clamp(area.y, clip.y, clip.y + clip.height - 1),
		width: 1,
		height: 1
	};
}
function edgePadding(inset) {
	return {
		glow: Math.max(0, Math.max(0, Math.round(inset)) - 8),
		stroke: 8
	};
}
/** Body glow and frame stroke that keep the inner hole on the observation rectangle. */
function observationFramePadding(region, bounds) {
	const left = edgePadding(region.x - bounds.x);
	const top = edgePadding(region.y - bounds.y);
	const right = edgePadding(bounds.x + bounds.width - (region.x + region.width));
	const bottom = edgePadding(bounds.y + bounds.height - (region.y + region.height));
	return {
		glow: {
			top: top.glow,
			right: right.glow,
			bottom: bottom.glow,
			left: left.glow
		},
		stroke: {
			top: top.stroke,
			right: right.stroke,
			bottom: bottom.stroke,
			left: left.stroke
		}
	};
}
/** Inflate the observation rectangle by the stroke and glow, then clip to the work area. */
function observationFramePlacement(region, workArea) {
	const bounds = intersectRects({
		x: Math.round(region.x - 36),
		y: Math.round(region.y - 36),
		width: Math.max(1, Math.round(region.width + 72)),
		height: Math.max(1, Math.round(region.height + 72))
	}, workArea);
	const padding = observationFramePadding(region, bounds);
	return {
		bounds,
		glow: padding.glow,
		stroke: padding.stroke
	};
}
function observationFrameCssScript(glow, stroke) {
	return `(() => { const root = document.documentElement.style; ${[
		["--glow-top", glow.top],
		["--glow-right", glow.right],
		["--glow-bottom", glow.bottom],
		["--glow-left", glow.left],
		["--stroke-top", stroke.top],
		["--stroke-right", stroke.right],
		["--stroke-bottom", stroke.bottom],
		["--stroke-left", stroke.left]
	].map(([name, value]) => `root.setProperty(${JSON.stringify(name)}, ${JSON.stringify(`${String(value)}px`)});`).join("")} })()`;
}
function pointInRect(point, bounds) {
	return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
}
//#endregion
//#region src/overlays.ts
/**
* Selection toolbar and observation frame.
* Both windows, like the ball, opt out of screen capture.
*/
function denyWindowPermissions(created) {
	created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
		callback(false);
	});
}
async function attachOverlays(deps) {
	const toolbar = openToolbar(fileURLToPath(new URL("../selection-preload.cjs", import.meta.url)));
	const frame = openFrame();
	let barOrigin = {
		x: 0,
		y: 0
	};
	let language = "zh";
	toolbar.webContents.on("did-finish-load", () => {
		toolbar.webContents.send("orb:selection-state", { language });
	});
	ipcMain.handle("orb:selection-size", (event, size) => {
		if (!fromToolbar(event, toolbar) || !isSize(size) || toolbar.isDestroyed()) return { menuAbove: false };
		const work = workAreaOf(barOrigin);
		const bounds = selectionToolbarMenuBounds(barOrigin, size, work);
		toolbar.setBounds(bounds);
		return { menuAbove: bounds.y < barOrigin.y };
	});
	ipcMain.on("orb:selection-action", (event, payload) => {
		if (!fromToolbar(event, toolbar)) return;
		if (typeof payload !== "object" || payload === null) return;
		const record = payload;
		if (record.action !== "search" && record.action !== "translate" && record.action !== "send" && record.action !== "language") return;
		deps.write({
			type: "selection-action",
			action: record.action,
			...record.language === "zh" || record.language === "en" ? { language: record.language } : {}
		});
	});
	await Promise.all([toolbar.loadFile(fileURLToPath(new URL("../assets/selection-toolbar.html", import.meta.url))), frame.loadFile(fileURLToPath(new URL("../assets/observation-frame.html", import.meta.url)))]);
	function ack(id) {
		if (typeof id === "string") deps.write({
			type: "overlay-ack",
			id
		});
	}
	function hideToolbar() {
		if (!toolbar.isDestroyed() && toolbar.isVisible()) toolbar.hide();
	}
	function raiseChrome() {
		if (!frame.isDestroyed()) frame.setAlwaysOnTop(true, "floating");
		if (!toolbar.isDestroyed()) toolbar.setAlwaysOnTop(true, "screen-saver");
		const ball = deps.ball();
		if (ball && !ball.isDestroyed()) ball.setAlwaysOnTop(true, "screen-saver");
	}
	return { deliver(message) {
		if (typeof message !== "object" || message === null) return false;
		const record = message;
		if (record.type === "selection") {
			if (typeof record.x !== "number" || typeof record.y !== "number") return true;
			language = record.language === "en" ? "en" : "zh";
			const work = workAreaOf({
				x: record.x,
				y: record.y
			});
			const bounds = selectionToolbarBounds({
				x: record.x,
				y: record.y
			}, SELECTION_TOOLBAR_SIZE, work);
			barOrigin = {
				x: bounds.x,
				y: bounds.y
			};
			if (!toolbar.isDestroyed()) {
				toolbar.setBounds(bounds);
				toolbar.showInactive();
				toolbar.webContents.send("orb:selection-state", { language });
				raiseChrome();
			}
			return true;
		}
		if (record.type === "selection-hide") {
			hideToolbar();
			return true;
		}
		if (record.type === "selection-pointer") {
			if (typeof record.x !== "number" || typeof record.y !== "number") return true;
			if (toolbar.isDestroyed() || !toolbar.isVisible() || !pointInRect({
				x: record.x,
				y: record.y
			}, toolbar.getBounds())) hideToolbar();
			return true;
		}
		if (record.type === "selection-language") {
			language = record.language === "en" ? "en" : "zh";
			if (!toolbar.isDestroyed()) toolbar.webContents.send("orb:selection-state", { language });
			return true;
		}
		if (record.type === "selection-attach") {
			const ball = deps.ball();
			if (ball && !ball.isDestroyed() && typeof record.text === "string") {
				ball.webContents.send("orb:attach", record.text);
				ball.showInactive();
			}
			hideToolbar();
			return true;
		}
		if (record.type === "overlay-input") {
			const ball = deps.ball();
			if (ball && !ball.isDestroyed()) {
				if (record.active === true) ball.setIgnoreMouseEvents(true, { forward: true });
				else ball.setIgnoreMouseEvents(false);
			}
			if (record.active === true) hideToolbar();
			ack(record.id);
			return true;
		}
		if (record.type === "observation-frame") {
			showFrame(frame, record.bounds);
			raiseChrome();
			ack(record.id);
			return true;
		}
		return false;
	} };
}
function showFrame(frame, bounds) {
	if (frame.isDestroyed()) return;
	const region = readRect(bounds);
	if (region === void 0) {
		frame.hide();
		return;
	}
	const dip = toDip(region);
	const placement = observationFramePlacement(dip, workAreaOf({
		x: dip.x + dip.width / 2,
		y: dip.y + dip.height / 2
	}));
	frame.setBounds(placement.bounds);
	frame.webContents.executeJavaScript(observationFrameCssScript(placement.glow, placement.stroke)).catch(() => {});
	frame.showInactive();
}
function toDip(region) {
	if (process.platform !== "win32") return region;
	const dip = screen.screenToDipRect(null, {
		x: Math.round(region.x),
		y: Math.round(region.y),
		width: Math.round(region.width),
		height: Math.round(region.height)
	});
	return {
		x: dip.x,
		y: dip.y,
		width: dip.width,
		height: dip.height
	};
}
function workAreaOf(point) {
	const area = screen.getDisplayNearestPoint({
		x: Math.round(point.x),
		y: Math.round(point.y)
	}).workArea;
	return {
		x: area.x,
		y: area.y,
		width: area.width,
		height: area.height
	};
}
function readRect(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (typeof record.x !== "number" || typeof record.y !== "number" || typeof record.width !== "number" || typeof record.height !== "number") return;
	if (![
		record.x,
		record.y,
		record.width,
		record.height
	].every(Number.isFinite)) return void 0;
	if (record.width < 1 || record.height < 1) return void 0;
	return {
		x: record.x,
		y: record.y,
		width: record.width,
		height: record.height
	};
}
function fromToolbar(event, toolbar) {
	if (toolbar.isDestroyed()) return false;
	return event.sender === toolbar.webContents;
}
function isSize(value) {
	if (typeof value !== "object" || value === null) return false;
	const size = value;
	return typeof size.width === "number" && typeof size.height === "number" && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0 && size.width < 2e3 && size.height < 2e3;
}
function openToolbar(preload) {
	const created = new BrowserWindow({
		width: SELECTION_TOOLBAR_SIZE.width,
		height: SELECTION_TOOLBAR_SIZE.height,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		focusable: false,
		show: false,
		hasShadow: true,
		backgroundColor: "#00000000",
		roundedCorners: false,
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			preload,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	protect(created, "screen-saver");
	denyWindowPermissions(created);
	return created;
}
function openFrame() {
	const created = new BrowserWindow({
		width: 32,
		height: 32,
		frame: false,
		transparent: true,
		alwaysOnTop: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		focusable: false,
		show: false,
		hasShadow: false,
		backgroundColor: "#00000000",
		roundedCorners: false,
		...process.platform === "darwin" ? { type: "panel" } : {},
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true
		}
	});
	protect(created, "floating");
	denyWindowPermissions(created);
	created.setIgnoreMouseEvents(true, { forward: true });
	return created;
}
function protect(created, level) {
	if (process.platform === "win32") created.setContentProtection(true);
	created.setAlwaysOnTop(true, level);
	if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true
	});
	created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	created.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
}
//#endregion
//#region src/main.ts
/**
* Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
*/
const socketAddress = process.env.DSH_ORB_SOCKET ?? "";
const token = process.env.DSH_ORB_TOKEN ?? "";
const webPort = process.env.DSH_ORB_WEB_PORT ?? "";
const defaultSelection = {
	provider: "deepseek-official",
	model: "deepseek-flash",
	reasoningEffort: "max"
};
let chrome = {
	overlay: defaultSelection,
	background: defaultSelection,
	selectionEnabled: false,
	millifractionEnabled: false,
	openMain: false,
	catalog: { groups: [] }
};
let avatarToken = 0;
process.title = "dsh-orb-helper";
if (!socketAddress || !token) {
	console.error("dsh-orb helper: socket environment is missing");
	process.exit(1);
}
if (process.platform === "darwin") app.setActivationPolicy?.("accessory");
let win;
let tccWait;
let overlays;
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
	try {
		overlays = await attachOverlays({
			ball: () => win,
			write
		});
	} catch (error) {
		console.error(`dsh-orb helper: overlays did not open: ${error instanceof Error ? error.message : String(error)}`);
	}
	placement = new FloatingPlacement(win, (point) => {
		const display = screen.getDisplayNearestPoint({
			x: Math.round(point.x),
			y: Math.round(point.y)
		});
		return {
			bounds: display.bounds,
			workArea: display.workArea
		};
	}, () => screen.getAllDisplays().map((display) => display.bounds));
	win.webContents.on("did-finish-load", () => {
		if (win && !win.isVisible()) win.showInactive();
	});
	await win.loadFile(fileURLToPath(new URL("../assets/floating.html", import.meta.url)));
	connect(0);
});
ipcMain.handle("orb:expand", (event, expanded) => {
	if (!fromBall(event) || !placement || typeof expanded !== "boolean") return {
		expanded: false,
		horizontal: "left",
		vertical: "up",
		docked: void 0
	};
	return placement.setExpanded(expanded);
});
ipcMain.handle("orb:move", (event, request) => {
	if (!fromBall(event) || !placement || !isMove(request)) return { docked: void 0 };
	return placement.move(request.x, request.y, request.canDock);
});
ipcMain.handle("orb:clamp", async (event, canDock) => {
	if (!fromBall(event) || !placement) return { docked: void 0 };
	return placement.clamp(canDock !== false);
});
ipcMain.handle("orb:unsnap", async (event) => {
	if (!fromBall(event) || !placement) return { docked: void 0 };
	return placement.unsnap();
});
ipcMain.on("orb:prompt", (event, text) => {
	if (!fromBall(event)) return;
	write({
		type: "prompt",
		text
	});
});
ipcMain.on("orb:question-answer", (event, payload) => {
	if (!fromBall(event)) return;
	if (typeof payload !== "object" || payload === null) return;
	const record = payload;
	write({
		type: "question-answer",
		id: record.id,
		answers: record.answers
	});
});
ipcMain.on("orb:question-cancel", (event, id) => {
	if (!fromBall(event)) return;
	write({
		type: "question-cancel",
		id
	});
});
ipcMain.on("orb:history", (event) => {
	if (!fromBall(event)) return;
	write({ type: "history" });
});
ipcMain.on("orb:open", (event, sessionId) => {
	if (!fromBall(event)) return;
	if (typeof sessionId === "string") write({
		type: "open",
		sessionId
	});
});
ipcMain.on("orb:new", (event) => {
	if (!fromBall(event)) return;
	write({ type: "new" });
});
ipcMain.on("orb:permission", (event, preset) => {
	if (!fromBall(event)) return;
	if (typeof preset === "string") write({
		type: "permission",
		preset
	});
});
ipcMain.on("orb:stop", (event) => {
	if (!fromBall(event)) return;
	write({ type: "stop" });
});
ipcMain.handle("orb:menu", async (event) => {
	if (!fromBall(event) || !win) return;
	write({ type: "menu" });
	await showMenu(win);
});
ipcMain.on("orb:open-external", (event, url) => {
	if (!fromBall(event)) return;
	if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 4e3) return;
	shell.openExternal(url);
});
ipcMain.handle("orb:tcc-status", (event) => {
	if (!fromBall(event)) return tccUnavailable();
	return askTcc({ type: "tcc" });
});
ipcMain.handle("orb:tcc-open", (event, right) => {
	if (!fromBall(event)) return tccUnavailable();
	if (right !== "screen" && right !== "accessibility") return tccUnavailable();
	return askTcc({
		type: "tcc-open",
		right
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
	if (process.platform === "win32") created.setContentProtection(true);
	denyWindowPermissions(created);
	created.setAlwaysOnTop(true, "screen-saver");
	if (process.platform === "darwin") created.setVisibleOnAllWorkspaces(true, {
		visibleOnFullScreen: true,
		skipTransformProcessType: true
	});
	created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	created.webContents.on("context-menu", (event, params) => {
		if (params?.isEditable) return;
		event.preventDefault();
		write({ type: "menu" });
		setTimeout(() => {
			showMenu(created);
		}, 30);
	});
	created.webContents.on("will-navigate", (event) => {
		event.preventDefault();
	});
	created.on("closed", () => {
		if (!quitting) app.quit();
	});
	created.once("ready-to-show", () => {
		created.showInactive();
		if (process.platform === "win32") created.setContentProtection(true);
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
			token,
			pid: process.pid
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
	if (overlays?.deliver(message)) return;
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
	if (record.type === "question-error") {
		win.webContents.send("orb:question-error", message);
		return;
	}
	if (record.type === "permission") {
		win.webContents.send("orb:permission", record.preset);
		return;
	}
	if (record.type === "history") {
		win.webContents.send("orb:history", record.items);
		return;
	}
	if (record.type === "reset") {
		win.webContents.send("orb:reset");
		return;
	}
	if (record.type === "chrome") {
		chrome = readChrome(record);
		return;
	}
	if (record.type === "avatar") {
		const version = record.version;
		loadAvatar(typeof version === "number" ? version : 0);
		return;
	}
	if (record.type === "tcc") {
		const wait = tccWait;
		tccWait = void 0;
		wait?.(record.status);
	}
}
function fromBall(event) {
	if (!win || win.isDestroyed()) return false;
	return event.sender === win.webContents;
}
function tccUnavailable() {
	return {
		applicable: false,
		appName: "",
		screen: "granted",
		accessibility: "granted"
	};
}
function askTcc(message) {
	const previous = tccWait;
	tccWait = void 0;
	previous?.(tccUnavailable());
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (tccWait !== finish) return;
			tccWait = void 0;
			resolve(tccUnavailable());
		}, 3e3);
		const finish = (status) => {
			clearTimeout(timer);
			resolve(status ?? tccUnavailable());
		};
		tccWait = finish;
		write(message);
	});
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
function zhLocale() {
	return (app.getLocale?.() ?? process.env.LANG ?? "").toLowerCase().startsWith("zh");
}
function readChrome(value) {
	const record = value;
	return {
		overlay: selectionOr(record.overlay, chrome.overlay),
		background: selectionOr(record.background, chrome.background),
		selectionEnabled: record.selectionEnabled === true,
		millifractionEnabled: record.millifractionEnabled === true,
		openMain: record.openMain === true,
		catalog: record.catalog ?? { groups: [] }
	};
}
function selectionOr(value, fallback) {
	if (!value || typeof value.provider !== "string" || typeof value.model !== "string") return fallback;
	return value;
}
async function showMenu(window) {
	const template = contextMenuTemplate(chrome, zhLocale(), {
		openMain: () => {
			write({ type: "open-main" });
		},
		setOverlay: (selection) => {
			write({
				type: "set-overlay",
				selection
			});
		},
		setBackground: (selection) => {
			write({
				type: "set-background",
				selection
			});
		},
		setSelection: (enabled) => {
			write({
				type: "set-selection",
				enabled
			});
		},
		setMillifraction: (enabled) => {
			confirmMillifraction(window, enabled);
		},
		disable: () => {
			write({ type: "disable" });
		}
	});
	Menu.buildFromTemplate(template).popup({ window });
}
async function confirmMillifraction(window, enabled) {
	if (enabled === chrome.millifractionEnabled) return;
	const zh = zhLocale();
	const { response } = await dialog.showMessageBox(window, {
		type: "question",
		message: zh ? "新编码只在新对话中生效。" : "The new encoding takes effect in a new conversation.",
		detail: zh ? "当前对话不变，仍可从历史记录打开。取消不写入、不新建。" : "The current conversation stays unchanged and remains in History. Cancel leaves the default and this chat as they are.",
		buttons: zh ? ["取消", "新建对话"] : ["Cancel", "Create new conversation"],
		defaultId: 1,
		cancelId: 0,
		noLink: true
	});
	if (response !== 1) return;
	write({
		type: "set-millifraction",
		enabled
	});
}
async function loadAvatar(version) {
	const tokenId = ++avatarToken;
	if (!win) return;
	if (!version) {
		win.webContents.send("orb:avatar", "");
		return;
	}
	const image = await fetchAvatar(version);
	if (tokenId !== avatarToken || !win || !image) return;
	win.webContents.send("orb:avatar", `data:${image.mime};base64,${image.body.toString("base64")}`);
}
function fetchAvatar(version) {
	const port = Number(webPort);
	if (!Number.isInteger(port) || port <= 0 || !token) return Promise.resolve(void 0);
	return new Promise((resolve) => {
		const req = request({
			hostname: "127.0.0.1",
			port,
			path: `/.dsh-orb/avatar?v=${Math.trunc(version)}`,
			method: "GET",
			headers: { "x-dsh-orb-helper": token }
		}, (res) => {
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > 25e5) {
					req.destroy();
					resolve(void 0);
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (res.statusCode !== 200) {
					resolve(void 0);
					return;
				}
				resolve({
					mime: (typeof res.headers["content-type"] === "string" ? res.headers["content-type"].split(";")[0] : "image/gif") ?? "image/gif",
					body: Buffer.concat(chunks)
				});
			});
		});
		req.setTimeout(5e3, () => {
			req.destroy();
			resolve(void 0);
		});
		req.on("error", () => resolve(void 0));
		req.end();
	});
}
//#endregion
export {};
