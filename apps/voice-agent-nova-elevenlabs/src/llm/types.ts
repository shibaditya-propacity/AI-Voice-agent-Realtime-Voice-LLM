/** LLM / Bedrock types */

// ─── Conversation ─────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type MessageContent = TextContent | ToolUseContent | ToolResultContent;

export interface ConversationMessage {
  role: MessageRole;
  content: MessageContent[];
}

// ─── Bedrock ConverseStream format ───────────────────────────────────────────

export interface BedrockTextContent {
  text: string;
}

export interface BedrockToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface BedrockToolResult {
  toolUseId: string;
  content: Array<{ text: string }>;
  status?: 'success' | 'error';
}

export interface BedrockMessage {
  role: MessageRole;
  content: Array<
    | { text: string }
    | { toolUse: BedrockToolUse }
    | { toolResult: BedrockToolResult }
  >;
}

// ─── Streaming events ─────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'done'; stopReason: string };

// ─── Tools ───────────────────────────────────────────────────────────────────

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  required?: string[];
  items?: ToolParameter;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;
