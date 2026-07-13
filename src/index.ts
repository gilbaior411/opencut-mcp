#!/usr/bin/env node
/**
 * opencut-mcp — MCP server that drives OpenCut classic via Playwright + window.__editor.
 *
 * All actual editor work lives in ./tools; this file is only the MCP wire-up.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { closeSession, getSession } from "./browser.js";
import {
	AddMediaInput,
	AddTrackInput,
	DeleteInput,
	ExportInput,
	InsertClipInput,
	MoveInput,
	ScreenshotInput,
	SplitAtInput,
	TrimInput,
	zodToJson,
} from "./schemas.js";
import * as tools from "./tools.js";

const server = new Server(
	{ name: "opencut-mcp", version: "0.1.0" },
	{ capabilities: { tools: {} } },
);

const emptyInputSchema = { type: "object", properties: {} } as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{ name: "opencut_get_state", description: "Read timeline duration + track / element summary.", inputSchema: emptyInputSchema },
		{ name: "opencut_add_track", description: "Add a video/audio/text/graphic/effect track. Returns trackId.", inputSchema: zodToJson(AddTrackInput) },
		{ name: "opencut_add_media", description: "Upload a local file as MediaAsset. Returns { id, name, duration, type }.", inputSchema: zodToJson(AddMediaInput) },
		{ name: "opencut_insert_clip", description: "Insert an element referencing a MediaAsset onto a track.", inputSchema: zodToJson(InsertClipInput) },
		{ name: "opencut_split_at", description: "Split element(s) at time. Undoable via opencut_undo.", inputSchema: zodToJson(SplitAtInput) },
		{ name: "opencut_move", description: "Move element start (optionally to a new track).", inputSchema: zodToJson(MoveInput) },
		{ name: "opencut_trim", description: "Update element trim / duration.", inputSchema: zodToJson(TrimInput) },
		{ name: "opencut_delete", description: "Delete element(s).", inputSchema: zodToJson(DeleteInput) },
		{ name: "opencut_undo", description: "Undo the last command.", inputSchema: emptyInputSchema },
		{ name: "opencut_redo", description: "Redo the last undone command.", inputSchema: emptyInputSchema },
		{ name: "opencut_export", description: "Trigger renderer.exportProject and wait for completion.", inputSchema: zodToJson(ExportInput) },
		{ name: "opencut_screenshot", description: "Screenshot the editor viewport for debugging.", inputSchema: zodToJson(ScreenshotInput) },
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	try {
		const result = await runTool(name, args ?? {});
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
	} catch (err) {
		const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
	}
});

async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
	switch (name) {
		case "opencut_get_state": return tools.getState();
		case "opencut_add_track": return tools.addTrack(AddTrackInput.parse(args));
		case "opencut_add_media": return tools.addMedia(AddMediaInput.parse(args));
		case "opencut_insert_clip": return tools.insertClip(InsertClipInput.parse(args));
		case "opencut_split_at": return tools.splitAt(SplitAtInput.parse(args));
		case "opencut_move": return tools.moveElement(MoveInput.parse(args));
		case "opencut_trim": return tools.trimElement(TrimInput.parse(args));
		case "opencut_delete": return tools.deleteElements(DeleteInput.parse(args));
		case "opencut_undo": return tools.undo();
		case "opencut_redo": return tools.redo();
		case "opencut_export": return tools.exportProject(ExportInput.parse(args));
		case "opencut_screenshot": return tools.screenshot(ScreenshotInput.parse(args));
		default: throw new Error(`unknown tool: ${name}`);
	}
}

async function main() {
	await getSession().catch((err) => {
		console.error("session boot failed:", err);
		process.exit(1);
	});
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, async () => {
		await closeSession();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
