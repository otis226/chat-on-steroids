import { describe, expect, it } from 'vitest';
import { claudeTuiRemoteControlReady } from '../src/main/harness/claude-surface.js';

describe('Claude normal TUI readiness', () => {
  it('recognizes ANSI-styled Remote Control active text', () => {
    const rendered = '\x1b[32m/remote-\x1b[0mcontrol is active · Continue here';
    expect(claudeTuiRemoteControlReady(rendered)).toBe(true);
  });

  it('does not treat the connecting indicator as ready', () => {
    expect(claudeTuiRemoteControlReady('\x1b[36m/rc\x1b[0mconnecting…')).toBe(false);
  });
});
