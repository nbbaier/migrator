import { expect, test } from "bun:test";
import { normaliseSql } from "./utils";

test("Check SQL Normalization", () => {
	const inputSql = `\
      CREATE TABLE "Node"( -- This is my table
          -- There are many like it but this one is mine
          A b, C D, "E F G", h)`;

	const expectedOutput = 'CREATE TABLE Node(A b,C D,"E F G",h)';

	const result = normaliseSql(inputSql);

	expect(result === expectedOutput).toBe(true);
});
