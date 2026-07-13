/**
 * demo.ts — end-to-end integration test AND demo recorder for opencut-mcp.
 *
 * Runs the sequence a Claude agent would execute:
 *   1. add video media
 *   2. add video track, insert clip at 0s
 *   3. add audio track, add audio media, insert BGM at 0s
 *   4. split video at 5s (simulate a cut)
 *   5. delete the second half
 *   6. screenshot the timeline
 *   7. (optional) export
 *
 * Set OPENCUT_VIDEO_DIR=/tmp/opencut-record and OPENCUT_HEADLESS=false to record
 * a webm screencast of the editor UI as tools operate on it.
 *
 * Usage:
 *   OPENCUT_HEADLESS=false OPENCUT_VIDEO_DIR=/tmp/opencut-record \
 *     bunx tsx scripts/demo.ts
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { closeSession, getSession } from "../src/browser.js";
import * as tools from "../src/tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const VIDEO = resolve(REPO_ROOT, "media/demo-video.mp4");
const BGM = resolve(REPO_ROOT, "media/demo-bgm.mp3");

function log(step: string, data?: unknown) {
	if (data !== undefined) {
		console.log(`\n[${step}]`, JSON.stringify(data, null, 2));
	} else {
		console.log(`\n[${step}]`);
	}
}

async function pause(ms: number) {
	// Slow demo down so each operation is visible in the recording.
	const slowdown = process.env.OPENCUT_DEMO_PACE === "slow" ? 3 : 1;
	await new Promise((r) => setTimeout(r, ms * slowdown));
}

async function main() {
	log("boot session (this launches chromium + goes to /editor)");
	const session = await getSession();
	log("editor ready", { projectId: session.projectId });

	log("initial state");
	console.log(await tools.getState());

	log("1. add video media", { file: VIDEO });
	const videoAsset = (await tools.addMedia({ filePath: VIDEO })) as {
		id: string;
		name: string;
		duration?: number;
		type: string;
	};
	console.log(videoAsset);
	await pause(500);

	log("2. insert video clip at 0s (auto-placement creates track)");
	const clipInfo = await tools.insertClip({
		mediaId: videoAsset.id,
		elementType: "video",
		startTime: 0,
		duration: videoAsset.duration ?? 15,
	});
	console.log(JSON.stringify(clipInfo, null, 2));
	await pause(500);

	log("3. add audio media (BGM)", { file: BGM });
	const bgmAsset = (await tools.addMedia({ filePath: BGM })) as {
		id: string;
		name: string;
		duration?: number;
	};
	console.log(bgmAsset);
	await pause(300);

	log("4. insert BGM at 0s (auto-placement creates audio track)");
	const bgmInfo = await tools.insertClip({
		mediaId: bgmAsset.id,
		elementType: "audio",
		startTime: 0,
		duration: bgmAsset.duration ?? 8,
	});
	console.log(JSON.stringify(bgmInfo, null, 2));
	await pause(500);

	log("6. state after inserts");
	const state = await tools.getState();
	console.log(JSON.stringify(state, null, 2));

	// Find the inserted video element id from the state snapshot.
	const stateObj = state as {
		tracks: {
			main: Array<{ elements: Array<{ id: string; type: string }> }>;
			overlay: Array<{ elements: Array<{ id: string; type: string }> }>;
			audio: Array<{ elements: Array<{ id: string; type: string }> }>;
		};
	};
	const allElements = [
		...(stateObj.tracks.main[0]?.elements ?? []),
		...stateObj.tracks.overlay.flatMap((t) => t.elements),
		...stateObj.tracks.audio.flatMap((t) => t.elements),
	];
	const videoElement = allElements.find((el) => el.type === "video");
	if (videoElement) {
		log("7. split video at 5s", { videoElementId: videoElement.id });
		await tools.splitAt({ elementIds: [videoElement.id], time: 5 });
		await pause(500);
		log("8. state after split");
		console.log(await tools.getState());
	} else {
		log("skip split — no video element found in main track");
	}

	log("9. screenshot editor");
	const shot = await tools.screenshot({ path: "/tmp/opencut-demo-final.png" });
	console.log(shot);

	log("10. cleanup");
	await pause(500);
	await closeSession();
	log("done");
}

main().catch(async (err) => {
	console.error("demo failed:", err);
	await closeSession();
	process.exit(1);
});
