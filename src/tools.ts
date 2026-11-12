/**
 * Editor operations, callable both by the MCP server (src/index.ts) and by direct
 * scripts (scripts/demo.ts). Each function runs in the browser context via
 * evalInEditor and returns plain JSON.
 */
import { evalInEditor, getSession } from "./browser.js";

export type AddTrackInput = {
	type: "video" | "audio" | "text" | "graphic" | "effect";
	index?: number;
};

export type AddMediaInput = { filePath: string };

export type InsertClipInput = {
	mediaId: string;
	elementType: "video" | "audio" | "image";
	startTime: number;
	duration?: number;
	name?: string;
	trackId?: string; // if omitted, placement is mode:"auto" (recommended)
};

export type SplitAtInput = { elementIds: string[]; time: number };
export type MoveInput = { elementId: string; newStartTime: number; newTrackId?: string };
export type TrimInput = {
	elementId: string;
	trimStart?: number;
	trimEnd?: number;
	startTime?: number;
	duration?: number;
};
export type DeleteInput = { elementIds: string[] };
export type ExportInput = {
	format: "mp4" | "webm";
	quality: "low" | "medium" | "high";
	fps?: number;
	includeAudio: boolean;
};
export type ScreenshotInput = { path?: string };

export async function getState() {
	return evalInEditor<unknown>(`
		const e = window.__editor;
		const scene = e.scenes.getActiveScene();
		const tracks = scene ? scene.tracks : null;
		const summarize = (arr) => (arr ?? []).filter(Boolean).map(t => ({
			id: t.id,
			type: t.type,
			name: t.name,
			elementCount: t.elements?.length ?? 0,
			elements: (t.elements ?? []).map(el => ({
				id: el.id,
				type: el.type,
				name: el.name,
				startTime: el.startTime,
				startTimeSeconds: el.startTime / window.__opencut.TICKS_PER_SECOND,
				duration: el.duration,
				durationSeconds: el.duration / window.__opencut.TICKS_PER_SECOND,
				content: el.params?.content ?? null,
				mediaId: el.mediaId,
			})),
		}));
		return {
			projectId: e.project.getActiveOrNull()?.metadata.id ?? null,
			projectName: e.project.getActiveOrNull()?.metadata.name ?? null,
			duration: e.timeline.getTotalDuration(),
			durationSeconds: e.timeline.getTotalDuration() / window.__opencut.TICKS_PER_SECOND,
			lastFrame: e.timeline.getLastFrameTime?.() ?? null,
			tracks: {
				main: summarize([tracks?.main]),
				overlay: summarize(tracks?.overlay),
				audio: summarize(tracks?.audio),
			},
			assets: e.media.getAssets?.().map(a => ({ id: a.id, name: a.name, type: a.type, duration: a.duration })) ?? [],
		};
	`);
}

export async function renameProject({ name }: { name: string }) {
	return evalInEditor<{ id: string; name: string }>(
		`
		const project = window.__editor.project.getActiveOrNull();
		if (!project) throw new Error("No active project");
		await window.__editor.project.renameProject({ id: project.metadata.id, name: args.name });
		window.__editor.save.flush();
		return { id: project.metadata.id, name: args.name };
		`,
		{ name },
	);
}

export async function addTrack(input: AddTrackInput) {
	return evalInEditor<{ trackId: string }>(
		`
		const trackId = window.__editor.timeline.addTrack({ type: args.type, index: args.index ?? undefined });
		return { trackId };
		`,
		{ type: input.type, index: input.index ?? null },
	);
}

export async function addMedia(input: AddMediaInput) {
	const { page } = await getSession();
	const fs = await import("node:fs");
	const path = await import("node:path");
	if (!fs.existsSync(input.filePath)) {
		throw new Error(`file not found: ${input.filePath}`);
	}
	// The <input type="file"> is rendered by useFileUpload with display:none.
	// Wait for it to mount (may take a moment on initial project activation).
	await page.locator('input[type="file"]').first().waitFor({
		state: "attached",
		timeout: 15_000,
	});
	const inputEl = page.locator('input[type="file"]').first();
	await inputEl.setInputFiles(input.filePath);

	const initialCount = await evalInEditor<number>(
		`return window.__editor.media.getAssets?.().length ?? 0;`,
	);
	const filename = path.basename(input.filePath);
	const asset = await page.waitForFunction(
		({ initialCount, filename }) => {
			const assets = (window as unknown as {
				__editor: {
					media: {
						getAssets: () => Array<{
							id: string;
							name: string;
							duration: number;
							type: string;
						}>;
					};
				};
			}).__editor.media.getAssets?.();
			if (!assets || assets.length <= initialCount) return null;
			const match = assets.find((a) => a.name === filename) ?? assets[assets.length - 1];
			return match ?? null;
		},
		{ initialCount, filename },
		{ timeout: 30_000 },
	);
	return asset.jsonValue();
}

export async function insertClip(input: InsertClipInput) {
	return evalInEditor<unknown>(
		`
		const e = window.__editor;
		const asset = e.media.getAssets?.().find(a => a.id === args.mediaId);
		if (!asset) throw new Error("mediaId not found: " + args.mediaId);
		const src = asset.duration ?? args.duration ?? 5;
		const dur = args.duration ?? src;

		// Convert seconds → MediaTime (integer ticks). Requires __opencut exposure from Phase 1.
		const toTicks = window.__opencut?.mediaTimeFromSeconds
			|| ((n) => { throw new Error("window.__opencut not exposed — rebuild classic with Phase 1 patch"); });
		const startTicks = toTicks({ seconds: args.startTime });
		const durTicks = toTicks({ seconds: dur });
		const srcTicks = toTicks({ seconds: src });
		const zero = toTicks({ seconds: 0 });

		const baseElement = {
			name: args.name ?? asset.name,
			startTime: startTicks,
			duration: durTicks,
			trimStart: zero,
			trimEnd: zero,
			sourceDuration: srcTicks,
			params: {},
		};

		let element;
		if (args.elementType === "audio") {
			// AudioElement is a discriminated union — uploads must carry sourceType.
			element = { ...baseElement, type: "audio", sourceType: "upload", mediaId: args.mediaId };
		} else if (args.elementType === "video" || args.elementType === "image") {
			element = { ...baseElement, type: args.elementType, mediaId: args.mediaId };
		} else {
			throw new Error("unsupported elementType: " + args.elementType);
		}

		// Placement: explicit if trackId given, else auto (create track on demand).
		// Empty tracks get pruned by CommandManager reactor, so pre-creating tracks
		// via addTrack + then inserting won't work — must insert in one shot.
		const placement = args.trackId
			? { mode: "explicit", trackId: args.trackId }
			: { mode: "auto", trackType: args.elementType === "image" ? "video" : args.elementType };

		const errors = [];
		const origError = console.error;
		console.error = (...msgs) => { errors.push(msgs.map(String).join(' ')); origError.apply(console, msgs); };
		try {
			e.timeline.insertElement({ element, placement });
		} finally {
			console.error = origError;
		}

		const after = e.scenes.getActiveScene().tracks;
		const all = [
			...(after.main?.elements ?? []).map(el => ({ ...el, trackId: after.main.id })),
			...after.overlay.flatMap(t => t.elements.map(el => ({ ...el, trackId: t.id }))),
			...after.audio.flatMap(t => t.elements.map(el => ({ ...el, trackId: t.id }))),
		];
		const newest = all.find(el => el.mediaId === args.mediaId && el.startTime === args.startTime) ?? null;

		return {
			inserted: !!newest,
			elementId: newest?.id ?? null,
			trackId: newest?.trackId ?? null,
			totalDuration: e.timeline.getTotalDuration(),
			validationErrors: errors,
		};
		`,
		{ ...input },
	);
}

export type AddTextInput = {
	content: string;
	startTime?: number;
	duration?: number;
	name?: string;
	fontSize?: number;
	fontFamily?: string;
	color?: string;
	trackId?: string;
};

export async function addText(input: AddTextInput) {
	return evalInEditor<unknown>(
		`
		const e = window.__editor;
		const startTime = args.startTime ?? 0;
		const duration = args.duration ?? 3;
		const element = window.__opencut.createTextElement({
			content: args.content,
			startTimeSeconds: startTime,
			durationSeconds: duration,
			name: args.name,
			fontSize: args.fontSize,
			fontFamily: args.fontFamily,
			color: args.color,
		});
		const placement = args.trackId
			? { mode: "explicit", trackId: args.trackId }
			: { mode: "auto", trackType: "text" };
		e.timeline.insertElement({ element, placement });
		const tracks = e.scenes.getActiveScene().tracks;
		const allTracks = [
			...(tracks.main ? [tracks.main] : []),
			...(tracks.overlay ?? []),
			...(tracks.audio ?? []),
		];
		const startTicks = window.__opencut.mediaTimeFromSeconds({ seconds: startTime });
		const inserted = allTracks
			.flatMap((track) => track.elements.map((item) => ({ ...item, trackId: track.id })))
			.find((item) => item.type === "text" && item.startTime === startTicks && item.params?.content === args.content);
		return {
			inserted: !!inserted,
			trackId: inserted?.trackId ?? null,
			elementId: inserted?.id ?? null,
			startTime,
			duration,
		};
		`,
		{ ...input },
	);
}

export async function splitAt(input: SplitAtInput) {
	return evalInEditor<unknown>(
		`
		const t = window.__opencut.mediaTimeFromSeconds({ seconds: args.time });
	const scene = window.__editor.scenes.getActiveScene();
	const tracks = scene?.tracks;
	const allTracks = [
		...(tracks.main ? [tracks.main] : []),
		...(tracks.overlay ?? []),
		...(tracks.audio ?? []),
	];
	const elements = args.elementIds
		.map((elementId) => {
			const track = allTracks.find((item) =>
				item.elements.some((element) => element.id === elementId),
			);
			return track ? { trackId: track.id, elementId } : null;
		})
		.filter((item) => item !== null);
	if (elements.length !== args.elementIds.length) {
		throw new Error("One or more element IDs were not found on the timeline");
	}
	const rightSideElements = window.__editor.timeline.splitElements({
		elements,
		splitTime: t,
	});
		return {
			ok: true,
			splitCount: rightSideElements.length,
			rightSideElements,
			totalDuration: window.__editor.timeline.getTotalDuration(),
		};
		`,
		{ ...input },
	);
}

export async function moveElement(input: MoveInput) {
	return evalInEditor<unknown>(
		`
		const move = {
			elementId: args.elementId,
			newStartTime: window.__opencut.mediaTimeFromSeconds({ seconds: args.newStartTime }),
		};
		if (args.newTrackId) move.newTrackId = args.newTrackId;
		window.__editor.timeline.moveElements({ moves: [move] });
		return { ok: true };
		`,
		{ ...input },
	);
}

export async function trimElement(input: TrimInput) {
	return evalInEditor<unknown>(
		`
		window.__editor.timeline.updateElementTrim({
			elementId: args.elementId,
			trimStart: args.trimStart ?? 0,
			trimEnd: args.trimEnd ?? 0,
			startTime: args.startTime ?? undefined,
			duration: args.duration ?? undefined,
		});
		return { ok: true };
		`,
		{ ...input },
	);
}

export async function deleteElements(input: DeleteInput) {
	return evalInEditor<unknown>(
		`
		window.__editor.timeline.deleteElements({ elements: args.elementIds });
		return { ok: true };
		`,
		{ ...input },
	);
}

export async function undo() {
	return evalInEditor<unknown>(`window.__editor.command.undo(); return { ok: true };`);
}

export async function redo() {
	return evalInEditor<unknown>(`window.__editor.command.redo(); return { ok: true };`);
}

export async function exportProject(input: ExportInput) {
	return evalInEditor<unknown>(
		`
		const result = await window.__editor.renderer.exportProject({ options: args });
		return result;
		`,
		{ ...input },
	);
}

export async function screenshot(input: ScreenshotInput) {
	const { page } = await getSession();
	const out = input.path ?? `/tmp/opencut-${Date.now()}.png`;
	await page.screenshot({ path: out, fullPage: false });
	return { path: out };
}
