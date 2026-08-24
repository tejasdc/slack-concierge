import { describe, expect, test } from "bun:test";
import {
  nextJournaledUnitFileAction,
  type JournaledFileEvidence,
  type JournaledUnitFile,
} from "../../src/deployment-repair/unit-file-journal";

function evidence(path: string, sha256: string | null, overrides: Partial<JournaledFileEvidence> = {}): JournaledFileEvidence {
  return {
    path,
    exists: sha256 !== null,
    uid: sha256 === null ? null : 0,
    gid: sha256 === null ? null : 0,
    mode: sha256 === null ? null : 0o644,
    sha256,
    ...overrides,
  };
}

describe("application cutover unit-file journal", () => {
  test("resumes every original-file crash boundary without changing rollback provenance", () => {
    const original = evidence("/unit.conf", "original");
    const absentBackup = evidence("/backup/unit.conf", null);
    const record: JournaledUnitFile = {
      path: original.path,
      intended_sha256: "intended",
      original,
      backup_path: absentBackup.path,
      state: "prepared",
    };
    expect(nextJournaledUnitFileAction(record, original, absentBackup)).toBe("backup_original");
    const backup = evidence(record.backup_path, "original", { mode: 0o600 });
    expect(nextJournaledUnitFileAction(record, original, backup)).toBe("write_intended");
    const installed = evidence(record.path, "intended");
    expect(nextJournaledUnitFileAction(record, installed, backup)).toBe("mark_installed");
    expect(nextJournaledUnitFileAction({ ...record, state: "installed" }, installed, backup)).toBe("complete");
  });

  test("resumes an originally absent file after write and rejects unjournaled drift", () => {
    const absent = evidence("/unit.conf", null);
    const record: JournaledUnitFile = {
      path: absent.path,
      intended_sha256: "intended",
      original: absent,
      backup_path: "/backup/unit.conf",
      state: "prepared",
    };
    expect(nextJournaledUnitFileAction(record, absent, evidence(record.backup_path, null))).toBe("write_intended");
    expect(nextJournaledUnitFileAction(
      record,
      evidence(record.path, "intended"),
      evidence(record.backup_path, null),
    )).toBe("mark_installed");
    expect(() => nextJournaledUnitFileAction(
      record,
      evidence(record.path, "foreign"),
      evidence(record.backup_path, null),
    )).toThrow("changed outside");
  });

  test("backs up an identical preexisting file before treating it as installed", () => {
    const original = evidence("/unit.conf", "intended");
    const record: JournaledUnitFile = {
      path: original.path,
      intended_sha256: "intended",
      original,
      backup_path: "/backup/unit.conf",
      state: "prepared",
    };
    expect(nextJournaledUnitFileAction(record, original, evidence(record.backup_path, null))).toBe("backup_original");
    expect(nextJournaledUnitFileAction(
      record,
      original,
      evidence(record.backup_path, "intended", { mode: 0o600 }),
    )).toBe("mark_installed");
  });

  test("never repairs an installed file or accepts a changed backup", () => {
    const original = evidence("/unit.conf", "original");
    const installed: JournaledUnitFile = {
      path: original.path,
      intended_sha256: "intended",
      original,
      backup_path: "/backup/unit.conf",
      state: "installed",
    };
    expect(() => nextJournaledUnitFileAction(
      installed,
      evidence(installed.path, "original"),
      evidence(installed.backup_path, "original"),
    )).toThrow("drifted outside");
    expect(() => nextJournaledUnitFileAction(
      { ...installed, state: "prepared" },
      original,
      evidence(installed.backup_path, "changed"),
    )).toThrow("does not match");
  });
});
