import * as tar from "tar";

/**
 * Cache output archive abstraction. Wraps tar+gzip with deterministic settings
 * (portable headers, sorted file list) so identical inputs produce stable
 * archives. Note: the cache *key* is derived from file content hashes, not the
 * archive bytes, so this only needs to round-trip correctly.
 */
export async function createTarGz(
  cwd: string,
  relPaths: string[],
  destFile: string,
): Promise<void> {
  await tar.create(
    {
      gzip: true,
      file: destFile,
      cwd,
      portable: true,
      // mtime is normalized by `portable`; sorting keeps entry order stable.
    },
    [...relPaths].sort(),
  );
}

export async function extractTarGz(srcFile: string, destDir: string): Promise<void> {
  await tar.extract({
    file: srcFile,
    cwd: destDir,
  });
}
