import { buildSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { typeDefs } from "./schema.js";

describe("schema", () => {
  it("flashesSummary takes only fid, no page/limit", () => {
    const schema = buildSchema(typeDefs);
    const field = schema.getQueryType()?.getFields().flashesSummary;
    expect(field?.args.map((arg) => arg.name)).toEqual(["fid"]);
  });

  it("has no signup mutation", () => {
    const schema = buildSchema(typeDefs);
    expect(schema.getMutationType()?.getFields().signup).toBeUndefined();
  });

  it("has no orphaned SignupResponse type", () => {
    const schema = buildSchema(typeDefs);
    expect(schema.getTypeMap().SignupResponse).toBeUndefined();
  });
});
