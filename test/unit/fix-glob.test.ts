import { expect, test } from "bun:test";
import { matchesAnyGlob } from "../../src/lib/fix/glob.ts";

const PROTECTED = [
  "**/*.test.*",
  "**/*.spec.*",
  "tests/**",
  "spec/**",
  "**/conftest.py",
  "**/vitest.config.*",
];

test("matches test/spec files at any depth", () => {
  expect(matchesAnyGlob("src/foo.test.ts", PROTECTED)).toBe(true);
  expect(matchesAnyGlob("a/b/c/foo.spec.tsx", PROTECTED)).toBe(true);
  expect(matchesAnyGlob("tests/unit/x.ts", PROTECTED)).toBe(true);
  expect(matchesAnyGlob("spec/x.rb", PROTECTED)).toBe(true);
  expect(matchesAnyGlob("pkg/conftest.py", PROTECTED)).toBe(true);
  expect(matchesAnyGlob("vitest.config.ts", PROTECTED)).toBe(true);
});

test("does not match ordinary source files", () => {
  expect(matchesAnyGlob("src/foo.ts", PROTECTED)).toBe(false);
  expect(matchesAnyGlob("src/index.html", PROTECTED)).toBe(false);
  expect(matchesAnyGlob("lib/testing.ts", PROTECTED)).toBe(false);
});

test("an empty pattern list never matches", () => {
  expect(matchesAnyGlob("src/foo.test.ts", [])).toBe(false);
});
