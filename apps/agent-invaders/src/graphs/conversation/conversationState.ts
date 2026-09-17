import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { InboundCast } from "../../farcaster/inboundCast.js";
import type { PublishedCast } from "../../farcaster/farcasterGateway.js";
import type { ValidationVerdict } from "../../validation/castValidator.js";

export const ConversationState = Annotation.Root({
  ...MessagesAnnotation.spec,
  inbound: Annotation<InboundCast>,
  contextLoaded: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  draft: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  validation: Annotation<ValidationVerdict | null>({ reducer: (_, next) => next, default: () => null }),
  attempts: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  published: Annotation<PublishedCast | null>({ reducer: (_, next) => next, default: () => null }),
});

export type ConversationStateType = typeof ConversationState.State;
