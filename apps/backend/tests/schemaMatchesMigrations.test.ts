import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { join } from "node:path";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../src/db/schema.js";

// Migrations are written by hand and drizzle/meta keeps no snapshots, so nothing
// else notices a column added to src/db/schema without its migration: the types
// accept it and production answers "no such column".

type Shape = Record<string, { columns: string[]; indexes: string[] }>;

function shapeOf(sqlite: Database): Shape {
  const tables = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
    )
    .all();
  const shape: Shape = {};
  for (const { name } of tables) {
    const columns = sqlite
      .query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(`PRAGMA table_info("${name}")`)
      .all()
      .map((column) => `${column.name} ${column.type} notnull=${column.notnull} default=${column.dflt_value} pk=${column.pk}`)
      .sort();
    const indexes = sqlite
      .query<{ name: string; unique: number }, []>(`PRAGMA index_list("${name}")`)
      .all()
      .map((index) => {
        const keys = sqlite
          .query<{ name: string }, []>(`PRAGMA index_info("${index.name}")`)
          .all()
          .map((key) => key.name);
        return `${index.unique ? "unique " : ""}(${keys.join(", ")})`;
      })
      .sort();
    shape[name] = { columns, indexes };
  }
  return shape;
}

it("the migrations build exactly the schema the code declares", async () => {
  const migrated = new Database(":memory:");
  migrated.run("PRAGMA foreign_keys = OFF");
  migrate(drizzle(migrated), { migrationsFolder: join(import.meta.dir, "../drizzle") });

  const declared = new Database(":memory:");
  const empty = await generateSQLiteDrizzleJson({});
  const target = await generateSQLiteDrizzleJson(schema, undefined, "snake_case");
  for (const statement of await generateSQLiteMigration(empty, target)) declared.run(statement);

  expect(shapeOf(migrated)).toEqual(shapeOf(declared));
});
