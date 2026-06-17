/** LLM streaming types */

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; stopReason: string };
