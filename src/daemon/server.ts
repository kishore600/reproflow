import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMessage, ReproflowError } from '../errors.js';
import { BrowserSession, forceHeadless } from './browser.js';
import { createHandlers, SERIAL_METHODS } from './handlers.js';
import type { DaemonInfo } from './protocol.js';
import { removeDaemonState, writeDaemonState } from './state.js';

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface DaemonOptions {
  project: string;
  profile: string;
  headed: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function rpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof ReproflowError) {
    return { code: -32000, message: error.message, data: { code: error.code, hint: error.hint } };
  }
  return { code: -32603, message: errorMessage(error) };
}

/**
 * Hosts one persistent Chromium for a project. Runs until `shutdown`, 30 idle minutes
 * (REPROFLOW_IDLE_MS overrides), or the browser closing.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const { project, profile } = options;
  const idleMs = Number(process.env.REPROFLOW_IDLE_MS) || DEFAULT_IDLE_MS;

  let session: BrowserSession;
  try {
    session = await BrowserSession.launch({ profile, headed: options.headed });
  } catch (error) {
    // The client reads this line from the daemon log to explain why startup failed.
    process.stdout.write(`${JSON.stringify({ startupError: errorMessage(error) })}\n`);
    process.exit(1);
  }

  const info: DaemonInfo = {
    pid: process.pid,
    profile,
    headed: options.headed && !forceHeadless(),
    startedAt: new Date().toISOString(),
    project,
  };
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);

  let closing = false;
  let inFlight = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const server = createServer((req, res) => void handle(req, res));

  async function shutdown(reason: string): Promise<void> {
    if (closing) return;
    closing = true;
    if (idleTimer) clearTimeout(idleTimer);
    console.log(`[daemon] shutting down: ${reason}`);
    removeDaemonState(project, process.pid);
    server.close();
    server.closeAllConnections();
    await session.close();
    process.exit(0);
  }

  const secrets = new Set<string>();
  const handlers = createHandlers({
    session,
    project,
    info,
    secrets,
    shutdown: () => void shutdown('requested'),
  });

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (inFlight === 0) void shutdown('idle');
      else armIdleTimer();
    }, idleMs);
  };

  let serial: Promise<unknown> = Promise.resolve();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
      return send(403, { error: 'forbidden host' });
    }
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { error: 'not found' });
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      return send(401, { error: 'unauthorized' });
    }

    let request: { id?: unknown; method?: unknown; params?: unknown };
    try {
      request = JSON.parse(await readBody(req));
    } catch {
      return send(400, { error: 'invalid JSON body' });
    }
    const id = request.id ?? null;
    const method = typeof request.method === 'string' ? request.method : '';
    const handler = handlers[method];
    if (!handler) {
      return send(200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `unknown method ${method}` },
      });
    }

    inFlight++;
    try {
      const run = (): Promise<unknown> => handler(request.params);
      let pending: Promise<unknown>;
      if (SERIAL_METHODS.has(method)) {
        pending = serial.then(run, run);
        serial = pending;
      } else {
        pending = run();
      }
      send(200, { jsonrpc: '2.0', id, result: await pending });
    } catch (error) {
      send(200, { jsonrpc: '2.0', id, error: rpcError(error) });
    } finally {
      inFlight--;
      armIdleTimer();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  writeDaemonState(project, { ...info, port, token });
  armIdleTimer();
  console.log(
    `[daemon] ready pid=${process.pid} port=${port} profile=${profile} project=${project}`,
  );

  session.context.on('close', () => void shutdown('browser closed'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}
