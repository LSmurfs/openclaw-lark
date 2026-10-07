import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { resolveConfiguredSecretInputString } from 'openclaw/plugin-sdk/secret-input-runtime';
import { probeFeishu } from '../src/channel/probe';
import { runDiagnosis, traceByMessageId } from '../src/commands/diagnose';
import { getPluginVersion } from '../src/core/version';

vi.mock('openclaw/plugin-sdk/secret-input-runtime', () => ({ resolveConfiguredSecretInputString: vi.fn() }));
vi.mock('../src/channel/probe', () => ({ probeFeishu: vi.fn() }));
vi.mock('../src/core/lark-client', () => ({
  LarkClient: {
    globalConfig: undefined,
    fromAccount: () => ({ sdk: { application: { scope: { list: async () => ({ code: 0, data: { scopes: [] } }) } } } }),
  },
}));

const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function config(): OpenClawConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        appId: 'test-app',
        appSecret: { source: 'env', provider: 'env_main', id: 'TEST_FEISHU_SECRET' },
      },
    },
  } as OpenClawConfig;
}

describe('diagnostics on current OpenClaw hosts', () => {
  it('resolves SecretRefs before probing without rewriting the config', async () => {
    vi.mocked(resolveConfiguredSecretInputString).mockResolvedValue({ value: 'resolved-secret' });
    vi.mocked(probeFeishu).mockResolvedValue({ ok: true, botName: 'test-bot' });
    const cfg = config();
    const report = await runDiagnosis({ config: cfg });
    expect(probeFeishu).toHaveBeenCalledWith(expect.objectContaining({ appSecret: 'resolved-secret' }));
    expect(resolveConfiguredSecretInputString).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'channels.feishu.appSecret' }),
    );
    expect(typeof cfg.channels?.feishu?.appSecret).toBe('object');
    expect(report.environment.pluginVersion).toBe(getPluginVersion());
  });

  it('does not send unresolved credentials to the SDK', async () => {
    vi.mocked(resolveConfiguredSecretInputString).mockResolvedValue({ unresolvedRefReason: 'provider blocked' });
    const report = await runDiagnosis({ config: config() });
    expect(probeFeishu).not.toHaveBeenCalled();
    expect(report.accounts[0].checks).toContainEqual(expect.objectContaining({ name: '凭证解析', status: 'fail' }));
  });

  it('reads configured JSON logs and uses the same path for message traces', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lark-diagnose-test-'));
    directories.push(dir);
    const file = join(dir, 'gateway.log');
    await writeFile(
      file,
      [
        JSON.stringify({ time: '2026-09-30T00:00:00Z', _meta: { logLevelName: 'INFO' }, '0': 'normal message' }),
        JSON.stringify({ time: '2026-09-30T00:00:01Z', _meta: { logLevelName: 'ERROR' }, '0': '[msg:test-id] failed' }),
        '2026-09-30T00:00:02Z [warn]: legacy warning',
      ].join('\n'),
    );
    const cfg: OpenClawConfig = { logging: { file } };
    const report = await runDiagnosis({ config: cfg });
    expect(report.recentErrors).toHaveLength(2);
    expect(report.recentErrors[0]).toContain('[ERROR] [msg:test-id] failed');
    expect(await traceByMessageId('test-id', cfg)).toHaveLength(1);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: '日志文件', status: 'pass', message: file }));
  });
});
