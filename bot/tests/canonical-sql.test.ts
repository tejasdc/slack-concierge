import { describe, expect, test } from "bun:test";
import { canonicalSql } from "../src/canonical-sql";

describe("canonicalSql", () => {
  test("the live ledger's older index text matches the code's", () => {
    expect(canonicalSql("CREATE INDEX executions_open ON executions(turn_id) WHERE state IN ('intended', 'live', 'exited')"))
      .toBe(canonicalSql("CREATE INDEX IF NOT EXISTS executions_open ON executions(turn_id) WHERE state IN ('intended','live','exited')".replace(" IF NOT EXISTS", "")));
    expect(canonicalSql("CREATE INDEX executions_survival ON executions(provider, supervisor) WHERE adopted_live=1 AND state='released'"))
      .toBe(canonicalSql("create index executions_survival\n  ON executions(provider,supervisor) WHERE adopted_live = 1 AND state = 'released'"));
  });

  test("quoted text, columns and predicates still differ", () => {
    expect(canonicalSql("CREATE INDEX a ON t(x) WHERE s='a b'")).not.toBe(canonicalSql("CREATE INDEX a ON t(x) WHERE s='a  b'"));
    expect(canonicalSql("CREATE INDEX a ON t(x) WHERE s='A'")).not.toBe(canonicalSql("CREATE INDEX a ON t(x) WHERE s='a'"));
    expect(canonicalSql("CREATE INDEX a ON t(x,y)")).not.toBe(canonicalSql("CREATE INDEX a ON t(x)"));
    expect(canonicalSql("CREATE INDEX a ON t(x) WHERE y=1")).not.toBe(canonicalSql("CREATE INDEX a ON t(x) WHERE y=2"));
  });
});
