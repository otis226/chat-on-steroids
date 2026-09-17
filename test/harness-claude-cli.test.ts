/**
 * Pure Claude Code CLI argv builders and `claude agents --json` parsing — the exact
 * contract the product spec cares about most: a resume must never re-supply
 * name/model/permission flags, because that can start a copy/new conversation.
 */

import { describe, expect, it } from 'vitest';
import {
  buildClaudeBootstrapArgs,
  buildClaudeResumeArgs,
  buildClaudeStopArgs,
  ClaudeCliError,
  findClaudeAgentBySessionId,
  parseClaudeAgentsJson
} from '../src/main/harness/claude-cli.js';

describe('buildClaudeBootstrapArgs', () => {
  it('builds the normal interactive --remote-control --name --session-id surface without a prompt', () => {
    expect(buildClaudeBootstrapArgs({ sessionId: 'uuid-1', title: 'My task' })).toEqual([
      '--remote-control',
      '--name',
      'My task',
      '--session-id',
      'uuid-1'
    ]);
  });

  it('adds optional model and permission-mode flags while remaining interactive', () => {
    expect(
      buildClaudeBootstrapArgs({ sessionId: 'uuid-1', title: 'T', model: 'opus', permissionMode: 'acceptEdits' })
    ).toEqual([
      '--remote-control',
      '--name',
      'T',
      '--session-id',
      'uuid-1',
      '--model',
      'opus',
      '--permission-mode',
      'acceptEdits'
    ]);
  });

  it('never includes --no-session-persistence', () => {
    const args = buildClaudeBootstrapArgs({ sessionId: 'uuid-1', title: 'T', model: 'opus' });
    expect(args).not.toContain('--no-session-persistence');
    expect(args).not.toContain('--bg');
  });
});

describe('buildClaudeResumeArgs', () => {
  it('is exactly --bg --resume <sessionId> <prompt>, with nothing else', () => {
    expect(buildClaudeResumeArgs({ sessionId: 'uuid-1', prompt: 'keep going' })).toEqual([
      '--bg',
      '--resume',
      'uuid-1',
      'keep going'
    ]);
  });
});

describe('buildClaudeStopArgs', () => {
  it('uses Claude background daemon short-id transport derived from the exact saved UUID', () => {
    expect(buildClaudeStopArgs('12345678-abcd-ef00-1111-222233334444')).toEqual(['stop', '12345678']);
  });
});

describe('parseClaudeAgentsJson', () => {
  it('accepts a bare array of agent rows', () => {
    expect(parseClaudeAgentsJson(JSON.stringify([{ sessionId: 's1', name: 'a' }]))).toEqual([
      { sessionId: 's1', raw: { sessionId: 's1', name: 'a' } }
    ]);
  });

  it('accepts a { agents: [...] } wrapper and an "id" synonym', () => {
    const entries = parseClaudeAgentsJson(JSON.stringify({ agents: [{ id: 's1' }] }));
    expect(entries).toEqual([{ sessionId: 's1', raw: { id: 's1' } }]);
  });

  it('drops rows with no usable session id', () => {
    expect(parseClaudeAgentsJson(JSON.stringify([{ name: 'no id' }]))).toEqual([]);
  });

  it('throws on invalid JSON rather than reporting an empty list', () => {
    expect(() => parseClaudeAgentsJson('not json')).toThrow(ClaudeCliError);
  });

  it('throws on an unrecognised shape', () => {
    expect(() => parseClaudeAgentsJson('"just a string"')).toThrow(ClaudeCliError);
  });
});

describe('findClaudeAgentBySessionId', () => {
  it('finds the exact session and nothing else', () => {
    const entries = [
      { sessionId: 'a', raw: {} },
      { sessionId: 'b', raw: {} }
    ];
    expect(findClaudeAgentBySessionId(entries, 'b')).toEqual({ sessionId: 'b', raw: {} });
    expect(findClaudeAgentBySessionId(entries, 'c')).toBeNull();
  });
});
