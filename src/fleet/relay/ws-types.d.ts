// Minimal local declarations for the already-installed `ws` runtime package.
// The repo does not ship @types/ws; these cover only the relay server surface.
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export class WebSocket {
    static readonly OPEN: number;
    static readonly CLOSED: number;
    constructor(address: string, options?: { headers?: Record<string, string> });
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string | Buffer, callback?: (error?: Error) => void): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'pong', listener: () => void): this;
    on(event: 'open', listener: () => void): this;
    on(event: 'unexpected-response', listener: (request: unknown, response: { statusCode?: number }) => void): this;
  }

  export interface WebSocketServerOptions {
    noServer?: boolean;
    maxPayload?: number;
    perMessageDeflate?: boolean;
  }
  export class WebSocketServer {
    constructor(options: WebSocketServerOptions);
    readonly clients: Set<WebSocket>;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer,
      callback: (websocket: WebSocket) => void): void;
    emit(event: 'connection', websocket: WebSocket, request: IncomingMessage): boolean;
    on(event: 'connection', listener: (websocket: WebSocket, request: IncomingMessage) => void): this;
    close(callback?: () => void): void;
  }
}
