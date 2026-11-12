import { type BrowserContext, type Page, chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type EditorSession = {
	context: BrowserContext;
	page: Page;
	projectId: string;
};

const DEFAULT_BASE = process.env.OPENCUT_BASE_URL ?? "http://localhost:3000";
const HEADLESS = process.env.OPENCUT_HEADLESS !== "false"; // default headless
const VIDEO_DIR = process.env.OPENCUT_VIDEO_DIR; // if set, record screencast
const PROFILE_DIR = resolve(process.env.OPENCUT_PROFILE_DIR ?? ".opencut-profile");
const PROJECT_ID_FILE = resolve(".opencut-project-id");

/**
 * Buttons the editor pops up on first load that we need to click through
 * before `window.__editor` becomes usable. Ordered by priority: primary
 * "close" verbs first, "Next" last so a multi-step tour still advances if
 * no shortcut is present. Table-driven so `dismissBootDialogs` stays flat.
 */
const DIALOG_DISMISS_BUTTONS = [
	'button:has-text("Take a look anyway")',   // mobile gate
	'button:has-text("Get started")',           // welcome tour final
	'button:has-text("Skip the tour")',
	'button:has-text("Skip tour")',
	'button:has-text("Skip")',
	'button:has-text("Got it")',
	'button:has-text("Continue")',
	'button:has-text("Close")',
	'button[aria-label="Close"]',               // Radix DialogClose "X"
	'button:has-text("Next")',                  // advance a wizard step
] as const;

const MAX_DIALOG_HOPS = 6;

class SessionHolder {
	private promise: Promise<EditorSession> | null = null;

	get(): Promise<EditorSession> {
		if (!this.promise) this.promise = this.createSession();
		return this.promise;
	}

	async close(): Promise<void> {
		if (!this.promise) return;
		const s = await this.promise;
		await s.context.close();
		this.promise = null;
	}

	private async createSession(): Promise<EditorSession> {
		await mkdir(PROFILE_DIR, { recursive: true });
		const context = await chromium.launchPersistentContext(PROFILE_DIR, {
			executablePath: process.env.CHROMIUM_PATH,
			headless: HEADLESS,
			viewport: { width: 1600, height: 900 },
			recordVideo: VIDEO_DIR
				? { dir: VIDEO_DIR, size: { width: 1600, height: 900 } }
				: undefined,
		});
		const page = context.pages()[0] ?? await context.newPage();

		// classic loads react-scan from unpkg in dev mode (layout.tsx). Block it so
		// the demo screencast isn't cluttered with purple component outlines.
		await page.route("**/react-scan/**", (route) => route.abort());

		page.on("pageerror", (err) => {
			console.error("[browser pageerror]", err.message);
		});

		let projectId = process.env.OPENCUT_PROJECT_ID;
		if (!projectId) {
			try {
				projectId = (await readFile(PROJECT_ID_FILE, "utf8")).trim();
			} catch {
				projectId = undefined;
			}
		}

		if (projectId) {
			await page.goto(`${DEFAULT_BASE}/editor/${encodeURIComponent(projectId)}`, {
				waitUntil: "networkidle",
			});
		} else {
			await page.goto(`${DEFAULT_BASE}/projects`, { waitUntil: "networkidle" });
			const created = await tryCreateProject(page);
			if (!created) {
				throw new Error("failed to find 'New project' button on /projects");
			}
			await page.waitForURL("**/editor/**", { timeout: 15_000 });
			projectId = page.url().split("/editor/")[1]!.split("?")[0]!;
			await writeFile(PROJECT_ID_FILE, projectId, "utf8");
		}

		await dismissBootDialogs(page);
		await waitForEditor(page);
		const activeProjectId = await page.evaluate(() =>
			(window as unknown as { __editor: { project: { getActiveOrNull: () => { metadata: { id: string } } | null } } })
				.__editor.project.getActiveOrNull()?.metadata.id ?? null,
		);
		if (activeProjectId !== projectId) {
			throw new Error(`OpenCut loaded project ${activeProjectId ?? "none"}; expected ${projectId}`);
		}

		return { context, page, projectId };
	}
}

const holder = new SessionHolder();

async function tryCreateProject(page: Page): Promise<boolean> {
	for (const sel of [
		'button:has-text("New project")',
		'button:has-text("New Project")',
		'a:has-text("New project")',
	]) {
		const loc = page.locator(sel);
		if ((await loc.count()) > 0) {
			await loc.first().click();
			return true;
		}
	}
	return false;
}

/**
 * Click through mobile-gate + welcome tour + any residual Radix dialog.
 * Any single selector in DIALOG_DISMISS_BUTTONS may match; keep iterating
 * until nothing responds, up to MAX_DIALOG_HOPS. Falls back to Escape.
 */
async function dismissBootDialogs(page: Page): Promise<void> {
	for (let hop = 0; hop < MAX_DIALOG_HOPS; hop++) {
		if (!(await clickFirstMatching(page, DIALOG_DISMISS_BUTTONS))) break;
		await page.waitForTimeout(200);
	}
	await page.keyboard.press("Escape").catch(() => {});
	await page.waitForTimeout(300);
}

async function clickFirstMatching(
	page: Page,
	selectors: readonly string[],
): Promise<boolean> {
	for (const sel of selectors) {
		const btn = page.locator(sel).first();
		if ((await btn.count()) === 0) continue;
		try {
			await btn.click({ timeout: 500 });
			return true;
		} catch {
			// selector matched but click timed out — try the next one
		}
	}
	return false;
}

async function waitForEditor(page: Page): Promise<void> {
	await page.waitForFunction(
		() => typeof (window as unknown as { __editor?: unknown }).__editor === "object",
		{ timeout: 15_000 },
	);
}

export async function getSession(): Promise<EditorSession> {
	return holder.get();
}

export async function closeSession(): Promise<void> {
	return holder.close();
}

export async function evalInEditor<T>(
	fn: string,
	args?: Record<string, unknown>,
): Promise<T> {
	const { page } = await getSession();
	// Playwright's evaluate serializes args as JSON. We wrap `fn` (which references
	// window.__editor and receives the arg object) to keep tool code compact.
	return page.evaluate<T, { __body: string; __args: Record<string, unknown> | undefined }>(
		({ __body, __args }) => {
			// biome-ignore lint/security/noGlobalEval: intentional bridge for MCP tools
			const wrapped = new Function("args", `return (async () => { ${__body} })(args)`);
			return wrapped(__args) as T | Promise<T>;
		},
		{ __body: fn, __args: args },
	);
}
