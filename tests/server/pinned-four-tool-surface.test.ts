import { describe, expect, test } from 'bun:test';
import { TOOLS } from '../../src/server/mcp.ts';

// mcp-door — the paired file for the "Pinned four-tool surface"
// requirement: exactly four descriptors, names and arg shapes pinned.
describe('pinned four-tool surface', () => {
  test('tools/list returns exactly the four pinned descriptors', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(['board_view', 'next_digest', 'task_sync', 'verify']);
  });

  test('arg shapes are pinned: project required everywhere; task_sync carries the result enum', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.required).toContain('project');
      expect(tool.inputSchema.properties['project']!.type).toBe('string');
    }
    const taskSync = TOOLS.find((tool) => tool.name === 'task_sync')!;
    expect(taskSync.inputSchema.properties['result']!.enum).toEqual(['clean', 'gaps']);
    expect(taskSync.inputSchema.required).toEqual(['project', 'cardId', 'result']);
    const verify = TOOLS.find((tool) => tool.name === 'verify')!;
    expect(verify.inputSchema.required).toEqual(['project', 'cardId']);
  });
});
