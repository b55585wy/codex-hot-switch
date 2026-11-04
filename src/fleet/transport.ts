import { Client, Domain, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk';
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
// https-proxy-agent 5.x is CommonJS and exposes its factory as the module
// value. The named export only survives bundler interop, so use the default
// factory alias that native ESM can load from the external dependency.
import fleetCreateHttpsProxyAgent from 'https-proxy-agent';
import { validateFleetApiProxyUrl } from './model';

export interface FleetApiClientOptions {
  appId: string;
  appSecret: string;
  tenant?: 'feishu' | 'lark';
  apiProxyUrl?: string;
}

export type FleetAxiosConfig = AxiosRequestConfig & { $return_headers?: boolean };

/**
 * Intentional finite limit for the optional fleet proxy transport only. The SDK
 * default transport has no finite default; per-request `timeout`/`signal`
 * values still override this instance default.
 */
export const FLEET_PROXY_TIMEOUT_MS = 15_000;

/**
 * Builds the dedicated fleet transport. The proxy is isolated from every other
 * HTTP client; environment proxy discovery is disabled so it cannot double-proxy.
 */
export function createFleetAxiosTransport(proxyUrl: string): AxiosInstance {
  validateFleetApiProxyUrl(proxyUrl);
  return axios.create({
    proxy: false,
    timeout: FLEET_PROXY_TIMEOUT_MS,
    httpsAgent: fleetCreateHttpsProxyAgent(proxyUrl),
  });
}

/**
 * Adapts an Axios instance to the Lark SDK HttpInstance contract. The SDK's
 * default transport resolves with the response body, not AxiosResponse, and
 * returns `{ data, headers }` only when `$return_headers` is set.
 */
export function createFleetHttpInstance(proxyUrl: string, transport = createFleetAxiosTransport(proxyUrl)): HttpInstance {
  const fleetRequest = async <T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> => {
    const { $return_headers, ...request } = options;
    const response = await transport.request<unknown, { data: unknown; headers: unknown }>(request as FleetAxiosConfig);
    return ($return_headers ? { data: response.data, headers: response.headers } : response.data) as R;
  };
  const fleetRequestWith = <D>(method: string) =>
    <T = unknown, R = T, D2 = D>(url: string, options?: HttpRequestOptions<D2>): Promise<R> =>
      fleetRequest<T, R, D2>({ ...options, url, method });
  return {
    request: fleetRequest,
    get: fleetRequestWith('GET'),
    delete: fleetRequestWith('DELETE'),
    head: fleetRequestWith('HEAD'),
    options: fleetRequestWith('OPTIONS'),
    post: <T = unknown, R = T, D = unknown>(url: string, data?: D, options?: HttpRequestOptions<D>) =>
      fleetRequest<T, R, D>({ ...options, url, method: 'POST', data }),
    put: <T = unknown, R = T, D = unknown>(url: string, data?: D, options?: HttpRequestOptions<D>) =>
      fleetRequest<T, R, D>({ ...options, url, method: 'PUT', data }),
    patch: <T = unknown, R = T, D = unknown>(url: string, data?: D, options?: HttpRequestOptions<D>) =>
      fleetRequest<T, R, D>({ ...options, url, method: 'PATCH', data }),
  };
}

export function createFleetApiClient(options: FleetApiClientOptions): Client {
  const fleetDomain = options.tenant === 'lark' ? Domain.Lark : Domain.Feishu;
  const base = { appId: options.appId, appSecret: options.appSecret, domain: fleetDomain };
  if (!options.apiProxyUrl) return new Client(base);
  return new Client({ ...base, httpInstance: createFleetHttpInstance(options.apiProxyUrl) });
}

/** Keeps the exact existing client when no local proxy is configured. */
export function selectFleetApiClient(base: Client, options: FleetApiClientOptions): Client {
  return options.apiProxyUrl ? createFleetApiClient(options) : base;
}
