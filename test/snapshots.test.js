import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots } from "../src/snapshots.js";
const snapshot = () => ({
  schemas: [],
  routines: [],
  relations: [
    {
      id: "10",
      schema: "public",
      name: "items",
      size: "100",
      estimated_rows: "1",
      columns: [{ position: 1, name: "id", nullable: false }],
      constraints: [],
      indexes: [],
      partitions: [],
      logical_keys: [],
    },
  ],
});
test("diffs keep identity through renames and store only modified fields", () => {
  const a = snapshot(),
    b = snapshot();
  b.relations[0].columns[0].name = "identifier";
  assert.deepEqual(
    diffSnapshots(a, b).map((c) => [
      c.operation,
      c.entity_type,
      c.field,
      c.previous_value,
      c.new_value,
    ]),
    [["modified", "column", "name", "id", "identifier"]],
  );
  assert.deepEqual(diffSnapshots(null, b), []);
});
test("volatile statistics do not produce structural history; additions and removals retain values", () => {
  const a = snapshot(),
    b = snapshot();
  b.relations[0].size = "500";
  b.relations[0].estimated_rows = "15";
  assert.deepEqual(diffSnapshots(a, b), []);
  b.relations[0].columns.push({ position: 2, name: "note", nullable: true });
  const added = diffSnapshots(a, b)[0];
  assert.equal(added.previous_value, null);
  assert.equal(added.new_value.name, "note");
  const removed = diffSnapshots(b, a)[0];
  assert.equal(removed.previous_value.name, "note");
  assert.equal(removed.new_value, null);
});
test("incoming foreign key changes are linked to both tables", () => {
  const a = snapshot(),
    b = snapshot();
  b.relations[0].constraints.push({
    id: "30",
    name: "fk",
    type: "f",
    referenced_table_id: "20",
  });
  assert.deepEqual(diffSnapshots(a, b)[0].table_ids, ["10", "20"]);
});
