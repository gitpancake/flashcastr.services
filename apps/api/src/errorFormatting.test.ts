import { ApolloServer } from "@apollo/server";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { GraphQLError } from "graphql";
import { describe, expect, it } from "vitest";
import { errorFormattingOptions } from "./errorFormatting.js";

const typeDefs = `
  type Query {
    boom: String
    badInput: String
  }
`;

const resolvers = {
  Query: {
    boom: () => {
      throw new Error("boom: internal detail");
    },
    badInput: () => {
      throw new GraphQLError("fid is required.", { extensions: { code: "BAD_USER_INPUT" } });
    },
  },
};

async function buildTestServer() {
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const server = new ApolloServer({ schema, ...errorFormattingOptions });
  await server.start();
  return server;
}

describe("errorFormattingOptions", () => {
  it("does not include a stacktrace for a validation error", async () => {
    const server = await buildTestServer();

    const response = await server.executeOperation({ query: "{ nope }" });

    const body = response.body;
    if (body.kind !== "single") throw new Error("expected single result");
    const [error] = body.singleResult.errors ?? [];
    expect(error).toBeDefined();
    console.log("validation-error response:", JSON.stringify(body.singleResult, null, 2));
    expect(error?.extensions?.code).toBe("GRAPHQL_VALIDATION_FAILED");
    expect(error?.extensions).not.toHaveProperty("stacktrace");

    await server.stop();
  });

  it("does not leak the raw resolver error message or a stacktrace", async () => {
    const server = await buildTestServer();

    const response = await server.executeOperation({ query: "{ boom }" });

    const body = response.body;
    if (body.kind !== "single") throw new Error("expected single result");
    const [error] = body.singleResult.errors ?? [];
    expect(error).toBeDefined();
    console.log("resolver-throw response:", JSON.stringify(body.singleResult, null, 2));
    expect(error?.extensions).not.toHaveProperty("stacktrace");
    expect(error?.message).not.toContain("internal detail");

    await server.stop();
  });

  it("preserves message and code for a deliberate client-facing GraphQLError", async () => {
    const server = await buildTestServer();

    const response = await server.executeOperation({ query: "{ badInput }" });

    const body = response.body;
    if (body.kind !== "single") throw new Error("expected single result");
    const [error] = body.singleResult.errors ?? [];
    expect(error?.message).toBe("fid is required.");
    expect(error?.extensions?.code).toBe("BAD_USER_INPUT");

    await server.stop();
  });
});
