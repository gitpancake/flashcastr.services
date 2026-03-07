import { GraphQLError } from "graphql";

export const UNAUTHORIZED_ERROR_MESSAGE = "Unauthorized: Invalid API key";
export const UNAUTHORIZED_ERROR_CODE = "UNAUTHORIZED";

export function verifyApiKey(context: { req?: { headers: Record<string, string | undefined> } }): void {
  const apiKey = context.req?.headers["x-api-key"] || context.req?.headers["X-API-KEY"];
  const validApiKey = process.env.API_KEY;

  if (!apiKey || apiKey !== validApiKey) {
    throw new GraphQLError(UNAUTHORIZED_ERROR_MESSAGE, {
      extensions: { code: UNAUTHORIZED_ERROR_CODE },
    });
  }
}
