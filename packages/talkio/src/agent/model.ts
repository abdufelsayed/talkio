/**
 * Model Calls
 *
 * Calls a talker or thinker model the same way for both. A model is a
 * provider object or a function; it reports through the context, or returns
 * a stream of text that is reported as tokens and completed when it ends.
 *
 * @module agent/model
 */

import { isLLMProvider, type LLMContext, type LLMInput } from "../providers/types";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] ===
    "function"
  );
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Calls `model` with `ctx`. A returned stream is read while `isActive` holds.
 * Anything the call throws or rejects with, including a stream error, goes to
 * `fail`.
 */
export function callModel(
  model: LLMInput,
  ctx: LLMContext,
  isActive: () => boolean,
  fail: (error: unknown) => void,
): void {
  const consume = async (stream: AsyncIterable<unknown>) => {
    for await (const token of stream) {
      if (!isActive()) return;
      ctx.token(token as string);
    }
    ctx.complete();
  };
  const settle = (result: unknown) => {
    if (isAsyncIterable(result)) consume(result).catch(fail);
  };
  try {
    const result = isLLMProvider(model) ? model.generate(ctx) : model(ctx);
    if (isPromiseLike(result)) result.then(settle, fail);
    else settle(result);
  } catch (error) {
    fail(error);
  }
}
