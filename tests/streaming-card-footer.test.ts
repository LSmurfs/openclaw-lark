import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sessions, resolveDefaultAgentId } = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  resolveDefaultAgentId: vi.fn(),
}));

vi.mock('openclaw/plugin-sdk/agent-runtime', () => ({ resolveDefaultAgentId }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  resolveStorePath: () => '/tmp/sessions',
  getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sessions.get(sessionKey),
}));

const { StreamingCardController } = await import('../src/card/streaming-card-controller');

function readMetrics(agentId: string, cfg: Record<string, unknown> = {}) {
  const controller = Object.create(StreamingCardController.prototype);
  controller.deps = { cfg, agentId, sessionKey: `agent:${agentId}:feishu:dm:user-1` };
  return controller.getFooterSessionMetrics();
}

beforeEach(() => {
  sessions.clear();
  resolveDefaultAgentId.mockReset();
});

describe('streaming card footer metrics', () => {
  it('does not resolve a default agent when an explicit-owner session is missing', async () => {
    resolveDefaultAgentId.mockImplementation(() => {
      throw new Error('AgentSelectionRequiredError');
    });
    sessions.set('agent:main:feishu:dm:user-1', { model: 'other-agent-model' });
    const cfg = { agents: { ownership: 'explicit', entries: { main: {}, hr: {} } } };

    expect(await readMetrics('hr', cfg)).toBeUndefined();
    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
  });

  it('reads the explicit agent session without requiring a default agent', async () => {
    resolveDefaultAgentId.mockImplementation(() => {
      throw new Error('AgentSelectionRequiredError');
    });
    const metrics = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheRead: 800,
      cacheWrite: 0,
      totalTokens: 2300,
      totalTokensFresh: true,
      contextTokens: 128000,
      model: 'test-model',
    };
    sessions.set('agent:main:feishu:dm:user-1', metrics);

    expect(await readMetrics('main')).toEqual(metrics);
    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
  });

  it('retains the legacy default-agent fallback when the primary session is absent', async () => {
    resolveDefaultAgentId.mockReturnValue('main');
    sessions.set('agent:main:feishu:dm:user-1', { model: 'fallback-model' });

    expect(await readMetrics('hr')).toMatchObject({ model: 'fallback-model' });
    expect(resolveDefaultAgentId).toHaveBeenCalledOnce();
  });
});
