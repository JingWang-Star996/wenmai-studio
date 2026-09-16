export type MetaBudgetMessage = Readonly<{
  role: string;
  content: string;
}>;

const REQUEST_OVERHEAD_TOKENS = 128;
const MESSAGE_OVERHEAD_TOKENS = 32;

/**
 * Reserve a provider-independent upper bound before an external model call.
 *
 * DeepSeek and Qwen do not expose a shared local tokenizer. UTF-8 byte length
 * is a conservative token upper bound for byte-fallback tokenizers; the fixed
 * request and per-message allowances cover the chat envelope. This value is a
 * budget reservation, not a claim about the provider's billed token count.
 */
export function conservativeInputTokenReservation(
  messages: readonly MetaBudgetMessage[],
): number {
  const encoder = new TextEncoder();
  return REQUEST_OVERHEAD_TOKENS + messages.reduce((total, message) => (
    total
      + MESSAGE_OVERHEAD_TOKENS
      + encoder.encode(message.role).byteLength
      + encoder.encode(message.content).byteLength
  ), 0);
}
