import { strict as assert } from "node:assert";
import { armMacLoginKeychainWatch, isKeychainDatabaseFile, isRelevantKeychainDatabaseEvent } from "../src/mac-login-keychain-watch";

let filePath: string | null = null;
let directoryWatches = 0;
let fallbackReports = 0;
let errors = 0;
const stopped = { value: false };
const options = {
  stopped: () => stopped.value,
  watchFile: (path: string) => { filePath = path; },
  watchDirectory: () => { directoryWatches += 1; },
  onFallback: () => { fallbackReports += 1; },
  onLookupError: () => { errors += 1; },
};

await armMacLoginKeychainWatch({ ...options, lookup: async () => ({ code: 0, output: '  "/Users/test/Library/Keychains/login.keychain-db"\n' }) });
assert.equal(filePath, "/Users/test/Library/Keychains/login.keychain-db");
assert.equal(directoryWatches, 0);

filePath = null;
await armMacLoginKeychainWatch({ ...options, lookup: async () => ({ code: 1, output: "" }) });
assert.equal(filePath, null);
assert.equal(directoryWatches, 1);
assert.equal(fallbackReports, 1);

stopped.value = true;
await armMacLoginKeychainWatch({ ...options, lookup: async () => ({ code: 0, output: "/late/keychain" }) });
assert.equal(filePath, null, "a stopped watcher must not arm after lookup completes");
assert.equal(directoryWatches, 1);
await armMacLoginKeychainWatch({ ...options, lookup: async () => { throw new Error("lookup failed"); } });
assert.equal(errors, 0, "shutdown suppresses late lookup errors");

assert.equal(isKeychainDatabaseFile("login.keychain-db"), true);
assert.equal(isKeychainDatabaseFile("login.keychain-db-wal"), true);
assert.equal(isKeychainDatabaseFile("unrelated.txt"), false);
assert.equal(isKeychainDatabaseFile(""), false);
assert.equal(isRelevantKeychainDatabaseEvent(null), true, "unknown filename must trigger an auth probe");
assert.equal(isRelevantKeychainDatabaseEvent(undefined), true, "missing filename must trigger an auth probe");
assert.equal(isRelevantKeychainDatabaseEvent("unrelated.txt"), false);

console.log("Mac keychain watcher fixture passed");
