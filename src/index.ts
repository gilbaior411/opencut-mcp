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
import { z } from "zod";
import { closeSession, getSession } from "./browser.js";
import * as tools from "./tools.js";

const server = new Server(
	{ name: "opencut-mcp", version: "0.1.0" },
	{ capabilities: { tools: {} } },
);

const AddTrackInput = z.object({
	type: z.enum(["video", "audio", "text", "graphic", "effect"]),
	index: z.number().int().optional(),
});
const AddMediaInput = z.object({ filePath: z.string() });
const InsertClipInput = z.object({
	trackId: z.string(),
	mediaId: z.string(),
	elementType: z.enum(["video", "audio", "image"]),
	startTime: z.number(),
	duration: z.number().optional(),
	name: z.string().optional(),
});
const SplitAtInput = z.object({ elementIds: z.array(z.string()), time: z.number() });
const MoveInput = z.object({
	elementId: z.string(),
	newStartTime: z.number(),
	newTrackId: z.string().optional(),
});
const TrimInput = z.object({
	elementId: z.string(),
	trimStart: z.number().optional(),
	trimEnd: z.number().optional(),
	startTime: z.number().optional(),
	duration: z.number().optional(),
});
const DeleteInput = z.object({ elementIds: z.array(z.string()) });
const ExportInput = z.object({
	format: z.enum(["mp4", "webm"]).default("mp4"),
	quality: z.enum(["low", "medium", "high"]).default("medium"),
	fps: z.number().optional(),
	includeAudio: z.boolean().default(true),
});
const ScreenshotInput = z.object({ path: z.string().optional() });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{ name: "opencut_get_state", description: "Read timeline duration + track / element summary.", inputSchema: { type: "object", properties: {} } },
		{ name: "opencut_add_track", description: "Add a video/audio/text/graphic/effect track. Returns trackId.", inputSchema: zodToJson(AddTrackInput) },
		{ name: "opencut_add_media", description: "Upload a local file as MediaAsset. Returns { id, name, duration, type }.", inputSchema: zodToJson(AddMediaInput) },
		{ name: "opencut_insert_clip", description: "Insert an element referencing a MediaAsset onto a track.", inputSchema: zodToJson(InsertClipInput) },
		{ name: "opencut_split_at", description: "Split element(s) at time. Undoable via opencut_undo.", inputSchema: zodToJson(SplitAtInput) },
		{ name: "opencut_move", description: "Move element start (optionally to a new track).", inputSchema: zodToJson(MoveInput) },
		{ name: "opencut_trim", description: "Update element trim / duration.", inputSchema: zodToJson(TrimInput) },
		{ name: "opencut_delete", description: "Delete element(s).", inputSchema: zodToJson(DeleteInput) },
		{ name: "opencut_undo", description: "Undo the last command.", inputSchema: { type: "object", properties: {} } },
		{ name: "opencut_redo", description: "Redo the last undone command.", inputSchema: { type: "object", properties: {} } },
		{ name: "opencut_export", description: "Trigger renderer.exportProject and wait for completion.", inputSchema: zodToJson(ExportInput) },
		{ name: "opencut_screenshot", description: "Screenshot the editor viewport for debugging.", inputSchema: zodToJson(ScreenshotInput) },
	],
}));

function zodToJson(schema: z.ZodType): Record<string, unknown> {
	if (schema instanceof z.ZodObject) {
		const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		for (const [key, val] of Object.entries(shape)) {
			properties[key] = zodFieldToJson(val as z.ZodType);
			if (!(val as z.ZodType).isOptional()) required.push(key);
		}
		return { type: "object", properties, required };
	}
	return { type: "object" };
}

function zodFieldToJson(field: z.ZodType): Record<string, unknown> {
	if (field instanceof z.ZodString) return { type: "string" };
	if (field instanceof z.ZodNumber) return { type: "number" };
	if (field instanceof z.ZodBoolean) return { type: "boolean" };
	if (field instanceof z.ZodEnum) return { type: "string", enum: (field as z.ZodEnum<[string, ...string[]]>).options };
	if (field instanceof z.ZodOptional) return zodFieldToJson((field as z.ZodOptional<z.ZodType>)._def.innerType);
	if (field instanceof z.ZodDefault) return zodFieldToJson((field as z.ZodDefault<z.ZodType>)._def.innerType);
	if (field instanceof z.ZodArray) return { type: "array", items: zodFieldToJson((field as z.ZodArray<z.ZodType>)._def.type) };
	return { type: "string" };
}

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
