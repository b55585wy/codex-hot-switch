import type { Client } from '@larksuiteoapi/node-sdk';
import type { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import fleetCreateHttpsProxyAgent from 'https-proxy-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ clients: [] as Array<Record<string, unknown>> }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor(options: Record<string, unknown>) { sdk.clients.push(options); } },
  Domain: { Feishu: 0, Lark: 1 },
}));

import { createFleetApiClient, createFleetAxiosTransport, createFleetHttpInstance, FLEET_PROXY_TIMEOUT_MS, selectFleetApiClient }
  from '../src/fleet/transport';
import { validateFleetApiProxyUrl, validateFleetConfig, type FleetConfig } from '../src/fleet/model';

const baseConfig: FleetConfig = { enabled: true, nodeId: '11111111-1111-4111-8111-111111111111',
  name: 'windows', appToken: 'appToken12345', tables: { nodes: 'tblNodes', routes: 'tblRoutes', commands: 'tblCommands' } };

beforeEach(() => { sdk.clients.length = 0; });

describe('fleet local API proxy configuration', () => {
  it('accepts HTTP and HTTPS proxy URLs with a host', () => {
    expect(() => validateFleetApiProxyUrl('http://127.0.0.1:7897')).not.toThrow();
    expect(() => validateFleetApiProxyUrl('https://proxy.example.test:8443')).not.toThrow();
    expect(() => validateFleetConfig({ ...baseConfig, apiProxyUrl: 'http://127.0.0.1:7897' })).not.toThrow();
  });
  it('rejects malformed, unsupported, non-string and credential-bearing values', () => {
    for (const value of ['', '  http://127.0.0.1:7897', 'http://127.0.0.1:7897 ', '127.0.0.1:7897',
      'ftp://proxy.example.test', 'http://', 'http:///proxy', 'http://user:pass@127.0.0.1:7897',
      'http://user@127.0.0.1:7897', 'http://127.0.0.1:7897\nX']) {
      expect(() => validateFleetApiProxyUrl(value)).toThrow();
      expect(() => validateFleetConfig({ ...baseConfig, apiProxyUrl: value })).toThrow();
    }
    expect(() => validateFleetConfig({ ...baseConfig, apiProxyUrl: 7897 as unknown as string })).toThrow();
  });
});

describe('fleet transport factory', () => {
  it('builds an isolated Axios transport with the HTTPS proxy agent and no environment proxy', () => {
    const transport = createFleetAxiosTransport('http://127.0.0.1:7897');
    expect(transport.defaults.httpsAgent).toBeInstanceOf(fleetCreateHttpsProxyAgent.HttpsProxyAgent);
    expect(transport.defaults.proxy).toBe(false);
    expect(createFleetAxiosTransport('https://proxy.example.test:8443').defaults.httpsAgent)
      .toBeInstanceOf(fleetCreateHttpsProxyAgent.HttpsProxyAgent);
  });

  it('defaults the optional proxy transport to a finite 15000 ms timeout and keeps request overrides', async () => {
    expect(FLEET_PROXY_TIMEOUT_MS).toBe(15_000);
    const transport = createFleetAxiosTransport('http://127.0.0.1:7897');
    expect(transport.defaults.timeout).toBe(15_000);

    const seen: InternalAxiosRequestConfig[] = [];
    const adapter = async (config: InternalAxiosRequestConfig) => {
      seen.push(config);
      return { data: { code: 0 }, status: 200, statusText: 'OK', headers: {}, config };
    };
    const url = 'https://open.feishu.cn/open-apis/bitable/v1/apps';

    await transport.request({ url, adapter });
    expect(seen[0]!.timeout).toBe(15_000);
    expect(seen[0]!.signal).toBeUndefined();

    const controller = new AbortController();
    await transport.request({ url, adapter, timeout: 2_000, signal: controller.signal } satisfies AxiosRequestConfig);
    expect(seen[1]!.timeout).toBe(2_000);
    expect(seen[1]!.signal).toBe(controller.signal);
  });

  it('preserves the SDK response-body contract, including $return_headers', async () => {
    const request = vi.fn(async (_config: unknown) => ({ data: { code: 0, data: { items: [] } },
      headers: { 'x-test': 'one' } }));
    const transport = { request } as unknown as AxiosInstance;
    const http = createFleetHttpInstance('http://127.0.0.1:7897', transport);

    expect(await http.request({ url: 'https://open.feishu.cn/open-apis/bitable/v1/apps', method: 'GET' }))
      .toEqual({ code: 0, data: { items: [] } });
    expect(await http.request({ url: 'https://open.feishu.cn/open-apis/bitable/v1/apps', method: 'GET', $return_headers: true }))
      .toEqual({ data: { code: 0, data: { items: [] } }, headers: { 'x-test': 'one' } });
    expect(request.mock.calls[0]![0]).not.toHaveProperty('$return_headers');
    expect(request.mock.calls[0]![0]).toMatchObject({ url: 'https://open.feishu.cn/open-apis/bitable/v1/apps', method: 'GET' });
  });

  it('passes method and body through each HttpInstance verb', async () => {
    const request = vi.fn(async (_config: unknown) => ({ data: { code: 0 }, headers: {} }));
    const http = createFleetHttpInstance('http://127.0.0.1:7897', { request } as unknown as AxiosInstance);
    await http.post('https://open.feishu.cn/one', { fields: {} }, { params: { a: 'b' } });
    await http.patch('https://open.feishu.cn/two', { fields: {} });
    expect(request.mock.calls[0]![0]).toMatchObject({ url: 'https://open.feishu.cn/one', method: 'POST',
      data: { fields: {} }, params: { a: 'b' } });
    expect(request.mock.calls[1]![0]).toMatchObject({ url: 'https://open.feishu.cn/two', method: 'PATCH', data: { fields: {} } });
  });

  it('keeps the original client when no proxy is configured and uses a dedicated client otherwise', () => {
    const base = { existing: true } as unknown as Client;
    expect(selectFleetApiClient(base, { appId: 'cli_test', appSecret: 'secret' })).toBe(base);
    expect(sdk.clients).toHaveLength(0);

    const plain = createFleetApiClient({ appId: 'cli_test', appSecret: 'secret', tenant: 'feishu' });
    expect(plain).toBeDefined();
    expect(sdk.clients[0]).toMatchObject({ appId: 'cli_test', appSecret: 'secret', domain: 0 });
    expect(sdk.clients[0]).not.toHaveProperty('httpInstance');

    const proxied = selectFleetApiClient(base, { appId: 'cli_test', appSecret: 'secret', tenant: 'lark',
      apiProxyUrl: 'http://127.0.0.1:7897' });
    expect(proxied).not.toBe(base);
    expect(sdk.clients[1]).toMatchObject({ appId: 'cli_test', appSecret: 'secret', domain: 1 });
    expect(sdk.clients[1]!.httpInstance).toMatchObject({ request: expect.any(Function), get: expect.any(Function) });
  });
});
