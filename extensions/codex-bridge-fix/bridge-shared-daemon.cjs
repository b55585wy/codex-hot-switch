const { Duplex } = require('node:stream');

function createSharedDaemonClient(BaseClient, options, dependencies = {}) {
  const WebSocket = dependencies.WebSocket || require('ws');
  const spawn = dependencies.spawn || require('cross-spawn');

  return new class SharedDaemonClient extends BaseClient {
    sharedDaemon = true;
    proxy = null;
    socket = null;
    closing = null;

    handleLine(line) {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      // Other clients still own their approval prompts. Never answer them here.
      if (message.id !== undefined && typeof message.method === 'string') return;
      super.handleLine(line);
    }

    async connect() {
      try {
        await this.openSocket();
        await this.request('initialize', {
          clientInfo: { name: 'feishu-codex-bridge-shared', version: '0.1' },
          capabilities: { experimentalApi: true, requestAttestation: false }
        }, 10000);
        this.notify('initialized');
      } catch (error) {
        await this.close();
        throw error;
      }
    }

    async openSocket() {
      const args = ['app-server', 'proxy'];
      if (options.socketPath) args.push('--sock', options.socketPath);
      const proxy = spawn(options.bin, args, {
        cwd: options.cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.proxy = proxy;
      const stream = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
      const socket = new WebSocket('ws://localhost/', {
        createConnection: () => stream,
        handshakeTimeout: 8000
      });
      this.socket = socket;
      // The base JSON-RPC client writes JSON to this connection, not to raw stdio.
      this.child = {
        pid: proxy.pid,
        stdin: { write: (payload, callback) => socket.send(payload.trimEnd(), callback) }
      };
      proxy.stderr.on('data', () => {});
      socket.on('message', bytes => this.handleLine(bytes.toString('utf8')));
      socket.on('error', error => this.connectionFailed(error));
      socket.on('close', () => this.connectionFailed(new Error('Shared daemon connection closed')));
      proxy.on('exit', (code, signal) => {
        this.hasExited = true;
        this.connectionFailed(new Error(`Daemon proxy exited (${code ?? signal})`));
      });
      proxy.on('error', error => this.connectionFailed(error));
      await new Promise((resolve, reject) => {
        const opened = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        const exited = () => failed(new Error('Daemon proxy exited before WebSocket opened'));
        const cleanup = () => {
          socket.off('open', opened);
          socket.off('error', failed);
          socket.off('close', exited);
          proxy.off('error', failed);
          proxy.off('exit', exited);
        };
        socket.once('open', opened);
        socket.once('error', failed);
        socket.once('close', exited);
        proxy.once('error', failed);
        proxy.once('exit', exited);
      });
    }

    connectionFailed(error) {
      this.closed = true;
      this.failAllPending(error);
      this.notifications.close();
      if (!this.closing) void this.close();
    }

    close() {
      if (this.closing) return this.closing;
      this.closing = Promise.resolve().then(async () => {
        this.closed = true;
        this.failAllPending(new Error('Shared daemon client closed'));
        this.notifications.close();
        await this.closeSocket();
        await this.closeProxy();
      });
      return this.closing;
    }

    async closeSocket() {
      const socket = this.socket;
      if (!socket || socket.readyState === WebSocket.CLOSED) return;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 800);
        socket.once('close', finish);
        if (socket.readyState === WebSocket.OPEN) socket.close(1000);
        else socket.terminate();
      });
    }

    async closeProxy() {
      const proxy = this.proxy;
      if (!proxy || proxy.exitCode !== null || proxy.signalCode !== null) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { proxy.kill(); resolve(); }, 800);
        proxy.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }(options);
}

module.exports = { createSharedDaemonClient };
