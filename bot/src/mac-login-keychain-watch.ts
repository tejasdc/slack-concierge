export type LoginKeychainLookup = Readonly<{ code: number | null; output: string; timedOut?: boolean }>;

/** A failed path query must not substitute the distinct default-keychain setting. */
export async function armMacLoginKeychainWatch(options: {
  lookup: () => Promise<LoginKeychainLookup>;
  stopped: () => boolean;
  watchFile: (path: string) => void;
  watchDirectory: () => void;
  onFallback: (result: LoginKeychainLookup) => void;
  onLookupError: (error: unknown) => void;
}): Promise<void> {
  try {
    const result = await options.lookup();
    if (options.stopped()) return;
    const path = result.code === 0 ? result.output.trim().replace(/^"|"$/g, "") : "";
    if (path) options.watchFile(path);
    else {
      options.watchDirectory();
      options.onFallback(result);
    }
  } catch (error) {
    if (!options.stopped()) options.onLookupError(error);
  }
}

export function isKeychainDatabaseFile(name: string): boolean {
  return /\.keychain(?:-db)?(?:-(?:wal|shm))?$/.test(name);
}

/** `fs.watch` may omit its filename; treat that event as an unknown change. */
export function isRelevantKeychainDatabaseEvent(name: string | null | undefined): boolean {
  return name == null || isKeychainDatabaseFile(name);
}
