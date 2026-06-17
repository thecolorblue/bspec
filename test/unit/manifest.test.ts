import { expect, test } from "bun:test";
import { buildManifestObject } from "../../src/lib/block-template.ts";

test("generated manifest contains expected fields", () => {
  const manifest = buildManifestObject(
    {
      id: "hello-extension",
      version: "0.1.0",
      summary: "A minimal hello extension fixture",
      produces: [],
    },
    ["manifest.json", "popup.html", "popup.js"],
  );

  expect(manifest.id).toBe("hello-extension");
  expect(manifest.version).toBe("0.1.0");
  expect(manifest.summary).toBe("A minimal hello extension fixture");
  expect(manifest.params).toEqual({});
  expect(manifest.produces).toEqual(["manifest.json", "popup.html", "popup.js"]);
  expect(manifest.needs).toEqual([]);
});
