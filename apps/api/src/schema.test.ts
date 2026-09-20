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

  it("Flash has a nullable image_url field alongside its existing fields", () => {
    const schema = buildSchema(typeDefs);
    const flashFields = (schema.getType("Flash") as import("graphql").GraphQLObjectType)?.getFields();
    expect(flashFields?.image_url?.type.toString()).toBe("String");
    expect(flashFields?.img).toBeDefined();
    expect(flashFields?.ipfs_cid).toBeDefined();
  });

  it("UnifiedFlash has a nullable image_url field alongside its existing fields", () => {
    const schema = buildSchema(typeDefs);
    const unifiedFlashFields = (
      schema.getType("UnifiedFlash") as import("graphql").GraphQLObjectType
    )?.getFields();
    expect(unifiedFlashFields?.image_url?.type.toString()).toBe("String");
    expect(unifiedFlashFields?.img).toBeDefined();
    expect(unifiedFlashFields?.ipfs_cid).toBeDefined();
  });

  it("FlashStoredEvent has a nullable image_url field alongside its existing fields", () => {
    const schema = buildSchema(typeDefs);
    const flashStoredEventFields = (
      schema.getType("FlashStoredEvent") as import("graphql").GraphQLObjectType
    )?.getFields();
    expect(flashStoredEventFields?.image_url?.type.toString()).toBe("String");
    expect(flashStoredEventFields?.img).toBeDefined();
    expect(flashStoredEventFields?.ipfs_cid).toBeDefined();
  });
});
