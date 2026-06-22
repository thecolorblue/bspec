/**
 * Pi does not list `./package.json` in its `exports` map, so the bundler
 * resolver rejects the subpath at typecheck time even though bun resolves the
 * real JSON at build/runtime. Declare the minimal shape bspec materializes for
 * Pi's `PI_PACKAGE_DIR` escape hatch (see src/lib/pi.ts).
 */
declare module "@earendil-works/pi-coding-agent/package.json" {
  const pkg: {
    name?: string;
    version?: string;
    piConfig?: { name?: string; configDir?: string };
  };
  export default pkg;
}
