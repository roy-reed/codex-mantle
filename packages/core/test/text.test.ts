import { describe, expect, it } from "vitest";
import { applyManagedBlock, decodeUtf8Text, encodeUtf8Text } from "../src/index.js";

describe("UTF-8 text preservation", () => {
  it("preserves a UTF-8 BOM and dominant CRLF newlines", () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        "before\r\n<!-- codex-mantle:rules:begin -->\r\nold\r\n<!-- codex-mantle:rules:end -->\r\nafter\r\n",
        "utf8",
      ),
    ]);

    const changed = applyManagedBlock(original, { blockId: "rules", content: "first\nsecond\n" });

    expect(changed.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(decodeUtf8Text(changed).text).toBe(
      "before\r\n<!-- codex-mantle:rules:begin -->\r\nfirst\r\nsecond\r\n<!-- codex-mantle:rules:end -->\r\nafter\r\n",
    );
  });

  it("keeps bytes outside an existing block untouched", () => {
    const prefix = "alpha  \n";
    const suffix = "\nOMEGA\t";
    const original = Buffer.from(
      `${prefix}<!-- codex-mantle:a.begin:begin -->\nreplace me\n<!-- codex-mantle:a.begin:end -->${suffix}`,
      "utf8",
    );

    const changed = applyManagedBlock(original, { blockId: "a.begin", content: "new" }).toString(
      "utf8",
    );

    expect(changed.startsWith(prefix)).toBe(true);
    expect(changed.endsWith(suffix)).toBe(true);
  });

  it("appends a single well-formed block when none exists", () => {
    const changed = applyManagedBlock(Buffer.from("existing", "utf8"), {
      blockId: "rules",
      content: "managed",
    }).toString("utf8");

    expect(changed).toBe(
      "existing\n\n<!-- codex-mantle:rules:begin -->\nmanaged\n<!-- codex-mantle:rules:end -->\n",
    );
  });

  it("rejects invalid UTF-8, NUL bytes, and malformed markers", () => {
    expect(() => decodeUtf8Text(Buffer.from([0xc3, 0x28]))).toThrow(/valid UTF-8/u);
    expect(() => decodeUtf8Text(Buffer.from([0]))).toThrow(/NUL/u);
    expect(() =>
      applyManagedBlock(Buffer.from("<!-- codex-mantle:x:begin -->\n", "utf8"), {
        blockId: "x",
        content: "value",
      }),
    ).toThrow(/malformed/u);
  });

  it("rejects managed content that injects its own markers", () => {
    expect(() =>
      applyManagedBlock(Buffer.alloc(0), {
        blockId: "x",
        content: "value\n<!-- codex-mantle:x:end -->\n",
      }),
    ).toThrow(/own markers/u);
  });

  it("round-trips explicit BOM policy", () => {
    expect(encodeUtf8Text({ bom: true, text: "内容\n" })).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("内容\n")]),
    );
  });
});
