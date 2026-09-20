import { describe, expect, it } from 'vitest';
import {
  inboundRequestId,
  inboundTransportKey,
  requestIdFromHeader,
  transportKeyFromHeader,
  withInboundRequestContext,
  withInboundRequestId
} from '../src/main/mcp/inbound.js';

describe('MCP inbound request id boundary', () => {
  it('normalizes the raw x-request-id to the page join key once at ingress', () => {
    expect(requestIdFromHeader('wfr_00000000000000000000000000000001/yqy1')).toBe(
      'wfr_00000000000000000000000000000001'
    );
    expect(requestIdFromHeader('  wfr_abc_123/relay-hop')).toBe('wfr_abc_123');
    expect(requestIdFromHeader(['wfr_only/a'])).toBe('wfr_only');
    expect(requestIdFromHeader(['wfr_first/a', 'wfr_second/b'])).toBeNull();

    expect(requestIdFromHeader('/missing-base')).toBeNull();
    expect(requestIdFromHeader('wfr.bad/suffix')).toBeNull();
    expect(requestIdFromHeader('x'.repeat(101))).toBeNull();
    expect(requestIdFromHeader(undefined)).toBeNull();
  });

  it('keeps normalized ids isolated across concurrent async requests', async () => {
    const seen = await Promise.all([
      withInboundRequestId('wfr_a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return inboundRequestId();
      }),
      withInboundRequestId('wfr_b', async () => {
        await Promise.resolve();
        return inboundRequestId();
      })
    ]);

    expect(seen).toEqual(['wfr_a', 'wfr_b']);
    expect(inboundRequestId()).toBeNull();
  });

  it('hashes native ChatGPT session identity without retaining the provider value', () => {
    const first = transportKeyFromHeader('opaque-current-chat');
    expect(first).toMatch(/^openai-session-[a-f0-9]{64}$/);
    expect(first).toBe(transportKeyFromHeader('opaque-current-chat'));
    expect(first).not.toContain('opaque-current-chat');
    expect(first).not.toBe(transportKeyFromHeader('another-chat'));
    expect(transportKeyFromHeader(['one', 'two'])).toBeNull();
    expect(transportKeyFromHeader('')).toBeNull();
    expect(transportKeyFromHeader('x'.repeat(4097))).toBeNull();
  });

  it('keeps native current-chat principals isolated across concurrent requests', async () => {
    const a = transportKeyFromHeader('chat-a')!;
    const b = transportKeyFromHeader('chat-b')!;
    const seen = await Promise.all([
      withInboundRequestContext({ requestId: 'request-a', transportKey: a }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [inboundRequestId(), inboundTransportKey()];
      }),
      withInboundRequestContext({ requestId: 'request-b', transportKey: b }, async () => {
        await Promise.resolve();
        return [inboundRequestId(), inboundTransportKey()];
      })
    ]);
    expect(seen).toEqual([['request-a', a], ['request-b', b]]);
    expect(inboundTransportKey()).toBeNull();
  });
});
