import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("vendored Absurd schema matches its recorded provenance", () => {
  const sql = readFileSync(new URL("../sql/vendor/absurd-0.5.0.sql", import.meta.url));
  const provenance = readFileSync(new URL("../sql/vendor/PROVENANCE.md", import.meta.url), "utf8");
  const recorded = provenance.match(/SHA-256: `([0-9a-f]{64})`/)?.[1];
  assert.ok(recorded, "PROVENANCE.md records a SHA-256");
  assert.equal(createHash("sha256").update(sql).digest("hex"), recorded);
  assert.match(sql.toString("utf8"), /0\.5\.0/);
});
