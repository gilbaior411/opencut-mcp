import { z } from "zod";

// Public MCP tool schemas. Also imported by tests to exercise validation
// without spinning up the MCP transport / Playwright.

export const AddTrackInput = z.object({
	type: z.enum(["video", "audio", "text", "graphic", "effect"]),
	index: z.number().int().optional(),
});

export const AddMediaInput = z.object({ filePath: z.string() });

export const InsertClipInput = z.object({
	mediaId: z.string(),
	elementType: z.enum(["video", "audio", "image"]),
	startTime: z.number(),
	duration: z.number().optional(),
	name: z.string().optional(),
	trackId: z.string().optional(),
});

export const SplitAtInput = z.object({
	elementIds: z.array(z.string()),
	time: z.number(),
});

export const MoveInput = z.object({
	elementId: z.string(),
	newStartTime: z.number(),
	newTrackId: z.string().optional(),
});

export const TrimInput = z.object({
	elementId: z.string(),
	trimStart: z.number().optional(),
	trimEnd: z.number().optional(),
	startTime: z.number().optional(),
	duration: z.number().optional(),
});

export const DeleteInput = z.object({ elementIds: z.array(z.string()) });

export const ExportInput = z.object({
	format: z.enum(["mp4", "webm"]).default("mp4"),
	quality: z.enum(["low", "medium", "high"]).default("medium"),
	fps: z.number().optional(),
	includeAudio: z.boolean().default(true),
});

export const ScreenshotInput = z.object({ path: z.string().optional() });

// Minimal Zod → JSON Schema converter used to advertise tool inputs over
// the MCP protocol. Handles the shapes we actually use (string / number /
// boolean / enum / optional / default / array). Not a general converter.
export function zodToJson(schema: z.ZodType): Record<string, unknown> {
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

export function zodFieldToJson(field: z.ZodType): Record<string, unknown> {
	if (field instanceof z.ZodString) return { type: "string" };
	if (field instanceof z.ZodNumber) return { type: "number" };
	if (field instanceof z.ZodBoolean) return { type: "boolean" };
	if (field instanceof z.ZodEnum) {
		return {
			type: "string",
			enum: (field as z.ZodEnum<[string, ...string[]]>).options,
		};
	}
	if (field instanceof z.ZodOptional) {
		return zodFieldToJson((field as z.ZodOptional<z.ZodType>)._def.innerType);
	}
	if (field instanceof z.ZodDefault) {
		return zodFieldToJson((field as z.ZodDefault<z.ZodType>)._def.innerType);
	}
	if (field instanceof z.ZodArray) {
		return {
			type: "array",
			items: zodFieldToJson((field as z.ZodArray<z.ZodType>)._def.type),
		};
	}
	return { type: "string" };
}
