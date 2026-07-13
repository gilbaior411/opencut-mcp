import { type Browser, type BrowserContext, type Page, chromium } from "playwright";

export type EditorSession = {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	projectId: string;
};

const DEFAULT_BASE = process.env.OPENCUT_BASE_URL ?? "http://localhost:3000";
const HEADLESS = process.env.OPENCUT_HEADLESS !== "false"; // default headless
const VIDEO_DIR = process.env.OPENCUT_VIDEO_DIR; // if set, record screencast

let sessionPromise: Promise<EditorSession> | null = null;

async function createSession(): Promise<EditorSession> {
	const browser = await chromium.launch({ headless: HEADLESS });
	const context = await browser.newContext({
		viewport: { width: 1600, height: 900 },
		recordVideo: VIDEO_DIR ? { dir: VIDEO_DIR, size: { width: 1600, height: 900 } } : undefined,
	});
	const page = await context.newPage();

	page.on("pageerror", (err) => {
		console.error("[browser pageerror]", err.message);
	});

	await page.goto(`${DEFAULT_BASE}/projects`, { waitUntil: "networkidle" });

	const created = await tryCreateProject(page);
	if (!created) {
		throw new Error("failed to find 'New project' button on /projects");
	}

	await page.waitForURL("**/editor/**", { timeout: 15_000 });
	const projectId = page.url().split("/editor/")[1]!.split("?")[0]!;

	await dismissMobileGate(page);
	await waitForEditor(page);

	return { browser, context, page, projectId };
}

async function tryCreateProject(page: Page): Promise<boolean> {
	const selectors = [
		'button:has-text("New project")',
		'button:has-text("New Project")',
		'a:has-text("New project")',
	];
	for (const sel of selectors) {
		const loc = page.locator(sel);
		if ((await loc.count()) > 0) {
			await loc.first().click();
			return true;
		}
	}
	return false;
}

async function dismissMobileGate(page: Page): Promise<void> {
	const skip = page.locator('button:has-text("Take a look anyway")');
	if ((await skip.count()) > 0) {
		await skip.first().click();
		await page.waitForTimeout(300);
	}
	// Welcome / beta dialog uses an "X" close button in DialogClose.
	// Iterate a few candidate texts so any of them dismisses cleanly.
	for (const label of ["Skip the tour", "Close", "Got it", "Continue"]) {
		const btn = page.locator(`button:has-text("${label}")`).first();
		if ((await btn.count()) > 0) {
			try {
				await btn.click({ timeout: 500 });
				await page.waitForTimeout(200);
			} catch {}
		}
	}
	// Fallback: hit Escape to close any remaining Radix dialog.
	await page.keyboard.press("Escape").catch(() => {});
	await page.waitForTimeout(200);
}

async function waitForEditor(page: Page): Promise<void> {
	await page.waitForFunction(
		() => typeof (window as unknown as { __editor?: unknown }).__editor === "object",
		{ timeout: 15_000 },
	);
}

export async function getSession(): Promise<EditorSession> {
	if (!sessionPromise) {
		sessionPromise = createSession();
	}
	return sessionPromise;
}

export async function closeSession(): Promise<void> {
	if (!sessionPromise) return;
	const s = await sessionPromise;
	await s.context.close();
	await s.browser.close();
	sessionPromise = null;
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
