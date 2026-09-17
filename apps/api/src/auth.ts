import { timingSafeEqual } from "crypto";
import { GraphQLError } from "graphql";

export const UNAUTHORIZED_ERROR_MESSAGE = "Unauthorized: Invalid API key";
export const UNAUTHORIZED_ERROR_CODE = "UNAUTHORIZED";

type HeaderValue = string | string[] | undefined;

export interface RequestContext {
  req?: {
    headers: Record<string, HeaderValue>;
    ip?: string;
  };
}

export type Resolver<Args, Result> = (parent: unknown, args: Args, context: RequestContext) => Result;

function firstHeaderValue(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyApiKey(context: RequestContext): void {
  const presented = firstHeaderValue(context.req?.headers["x-api-key"]);
  const expected = process.env.API_KEY;
  const isAuthorized = Boolean(presented && expected && secretsMatch(presented, expected));

  if (!isAuthorized) {
    throw new GraphQLError(UNAUTHORIZED_ERROR_MESSAGE, {
      extensions: { code: UNAUTHORIZED_ERROR_CODE },
    });
  }
}

export function withApiKey<Args, Result>(resolver: Resolver<Args, Result>): Resolver<Args, Result> {
  return (parent, args, context) => {
    verifyApiKey(context);
    return resolver(parent, args, context);
  };
}
