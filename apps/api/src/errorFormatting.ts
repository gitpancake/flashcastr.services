import type { GraphQLFormattedError } from "graphql";

const GENERIC_INTERNAL_ERROR_MESSAGE = "Internal server error";

// Apollo Server defaults extensions.code to INTERNAL_SERVER_ERROR whenever a
// resolver (or anything downstream of it) throws something that isn't
// already a deliberate, client-facing GraphQLError with its own code
// (validation errors, resolver-thrown GraphQLErrors with e.g. BAD_USER_INPUT).
// That default is the signal: an unexpected error's raw message must never
// reach the client.
function isUnexpectedInternalError(formattedError: GraphQLFormattedError): boolean {
  return formattedError.extensions?.code === "INTERNAL_SERVER_ERROR";
}

function formatError(formattedError: GraphQLFormattedError): GraphQLFormattedError {
  if (!isUnexpectedInternalError(formattedError)) return formattedError;

  return {
    ...formattedError,
    message: GENERIC_INTERNAL_ERROR_MESSAGE,
  };
}

export const errorFormattingOptions = {
  includeStacktraceInErrorResponses: false,
  formatError,
};
