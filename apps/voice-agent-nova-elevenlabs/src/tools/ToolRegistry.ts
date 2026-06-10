/**
 * ToolRegistry: extensible tool calling architecture for future CRM/DB integrations.
 *
 * Register tools here and they will be automatically included in every LLM request.
 * Tool handlers are async and must return a plain string result.
 *
 * Example:
 *   registry.register({
 *     name: 'get_property_details',
 *     description: 'Fetch details for a property by ID',
 *     inputSchema: {
 *       type: 'object',
 *       properties: { property_id: { type: 'string', description: 'The property ID' } },
 *       required: ['property_id'],
 *     },
 *   }, async (input) => {
 *     const details = await crmClient.getProperty(input.property_id as string);
 *     return JSON.stringify(details);
 *   });
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { Logger } from '../shared/logger';
import type { ToolDefinition, ToolHandler } from '../llm/types';

const log = Logger.root('ToolRegistry');

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      log.warn(`Overwriting existing tool: ${definition.name}`);
    }
    this.tools.set(definition.name, { definition, handler });
    log.info(`Tool registered: ${definition.name}`);
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      log.warn(`Unknown tool invoked: ${name}`);
      return `Error: Tool '${name}' is not registered.`;
    }
    try {
      log.info(`Executing tool: ${name}`, { input });
      const result = await tool.handler(input);
      log.info(`Tool result: ${name}`, { resultLength: result.length });
      return result;
    } catch (err) {
      log.error(`Tool execution failed: ${name}`, err as Error);
      return `Error executing tool '${name}': ${(err as Error).message}`;
    }
  }

  /** Returns tool definitions in Anthropic SDK format. */
  toAnthropicTools(): Tool[] {
    return Array.from(this.tools.values()).map(({ definition }): Tool => ({
      name:         definition.name,
      description:  definition.description,
      input_schema: definition.inputSchema,
    }));
  }

  get size(): number { return this.tools.size; }
  has(name: string): boolean { return this.tools.has(name); }
}

export const globalToolRegistry = new ToolRegistry();
