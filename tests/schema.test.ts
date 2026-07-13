/**
 * Unit tests for the MCP tool schemas. Import from src/schemas so the
 * observer's test-reachability graph counts src/schemas.ts as covered.
 *
 * Run with:
 *   bun test
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	AddTrackInput,
	ExportInput,
	InsertClipInput,
	zodFieldToJson,
	zodToJson,
} from "../src/schemas.js";

describe("AddTrackInput", () => {
	test("accepts valid track types", () => {
		for (const type of ["video", "audio", "text", "graphic", "effect"] as const) {
			expect(AddTrackInput.parse({ type }).type).toBe(type);
		}
	});
	test("rejects unknown track type", () => {
		expect(() => AddTrackInput.parse({ type: "foo" })).toThrow();
	});
	test("index is optional and must be integer", () => {
		expect(AddTrackInput.parse({ type: "video" }).index).toBeUndefined();
		expect(() => AddTrackInput.parse({ type: "video", index: 1.5 })).toThrow();
	});
});

describe("InsertClipInput", () => {
	test("minimal required fields", () => {
		const parsed = InsertClipInput.parse({
			mediaId: "m-1",
			elementType: "video",
			startTime: 0,
		});
		expect(parsed.mediaId).toBe("m-1");
		expect(parsed.trackId).toBeUndefined();
	});
	test("trackId omission means auto-placement (documented default)", () => {
		const parsed = InsertClipInput.parse({
			mediaId: "m-1",
			elementType: "audio",
			startTime: 1.5,
		});
		expect(parsed.trackId).toBeUndefined();
	});
	test("rejects unsupported element types", () => {
		expect(() =>
			InsertClipInput.parse({ mediaId: "m", elementType: "video-clip", startTime: 0 }),
		).toThrow();
	});
});

describe("ExportInput defaults", () => {
	test("applies mp4 / medium / includeAudio=true when omitted", () => {
		const parsed = ExportInput.parse({});
		expect(parsed.format).toBe("mp4");
		expect(parsed.quality).toBe("medium");
		expect(parsed.includeAudio).toBe(true);
	});
	test("respects explicit overrides", () => {
		const parsed = ExportInput.parse({
			format: "webm",
			quality: "high",
			includeAudio: false,
		});
		expect(parsed.format).toBe("webm");
		expect(parsed.quality).toBe("high");
		expect(parsed.includeAudio).toBe(false);
	});
});

describe("zodFieldToJson", () => {
	test("string / number / boolean", () => {
		expect(zodFieldToJson(z.string())).toEqual({ type: "string" });
		expect(zodFieldToJson(z.number())).toEqual({ type: "number" });
		expect(zodFieldToJson(z.boolean())).toEqual({ type: "boolean" });
	});
	test("enum preserves options", () => {
		expect(zodFieldToJson(z.enum(["a", "b"]))).toEqual({
			type: "string",
			enum: ["a", "b"],
		});
	});
	test("optional unwraps to inner type", () => {
		expect(zodFieldToJson(z.string().optional())).toEqual({ type: "string" });
	});
	test("default unwraps to inner type", () => {
		expect(zodFieldToJson(z.enum(["mp4", "webm"]).default("mp4"))).toEqual({
			type: "string",
			enum: ["mp4", "webm"],
		});
	});
	test("array preserves item type", () => {
		expect(zodFieldToJson(z.array(z.string()))).toEqual({
			type: "array",
			items: { type: "string" },
		});
	});
});

describe("zodToJson (object schemas)", () => {
	test("AddTrackInput → JSON Schema with required 'type'", () => {
		const json = zodToJson(AddTrackInput);
		expect(json.type).toBe("object");
		expect(json.required).toEqual(["type"]);
		expect((json.properties as Record<string, unknown>).type).toMatchObject({
			type: "string",
			enum: ["video", "audio", "text", "graphic", "effect"],
		});
	});
	test("ExportInput has no required fields (all defaulted or optional)", () => {
		const json = zodToJson(ExportInput);
		expect(json.required).toEqual([]);
	});
});
