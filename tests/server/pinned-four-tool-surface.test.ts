import { describe, expect, test } from 'bun:test';
import { TOOLS, MCP_TOOL_PROFILE } from '../../src/server/mcp.ts';

// the original four MCP tool names and arg shapes stay pinned; additive
// intake/collaboration/graph tools extend the surface without altering them
describe('pinned original four-tool surface', () => {
  test('the four original descriptors keep their names and arg shapes', () => {
    const names = TOOLS.map((tool) => tool.name);
    for (const pinned of MCP_TOOL_PROFILE.originalTools) {
      expect(names).toContain(pinned);
    }
    const taskSync = TOOLS.find((tool) => tool.name === 'task_sync')!;
    const resultProp = taskSync.inputSchema.properties['result'] as { enum?: string[] };
    expect(resultProp.enum).toEqual(['clean', 'gaps']);
    expect(taskSync.inputSchema.required).toEqual(['project', 'cardId', 'result']);
    const verify = TOOLS.find((tool) => tool.name === 'verify')!;
    expect(verify.inputSchema.required).toEqual(['project', 'cardId']);
  });

  test('every tool requires project; additive tools are declared in the profile', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.required).toContain('project');
      const projectProp = tool.inputSchema.properties['project'] as { type?: string };
      expect(projectProp.type).toBe('string');
    }
    const names = TOOLS.map((tool) => tool.name);
    for (const added of MCP_TOOL_PROFILE.additiveTools) {
      expect(names).toContain(added);
    }
  });
});
