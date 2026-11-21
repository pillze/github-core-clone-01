// The forge's HTTP surface: health probe, REST v3, GraphQL v4, MCP, and git smart HTTP.
// main.ts owns the entry<->env lifecycle; everything served lives here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { handleApiV3, sendJson, sendError, type Ctx } from './src/rest.ts';
import { handleGraphQL } from './src/gql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './src/githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function tokenOk(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true; // local runs without the env
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}`;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void route(req, res);
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = randomUUID().replace(/-/g, '').slice(0, 16);
  const rawPath = pathOf(req);
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://entry');

  // healthz: no auth, no body
  if (method === 'GET' && (rawPath === '/healthz' || rawPath === '/api/healthz')) {
    const text = `${JSON.stringify({ ok: true })}\n`;
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(text)) });
    res.end(text);
    return;
  }

  const authed = tokenOk(req);

  // read the body (bounded)
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total <= 64 * 1024 * 1024) chunks.push(b);
    else break;
  }
  const body = Buffer.concat(chunks);
  const ctx: Ctx = { req, res, url, body, requestId };

  // git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+?\.git)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(rawPath);
  if (gitMatch) {
    if (!authed) { sendError(ctx, 401, 'Requires authentication'); return; }
    const service = gitMatch[3]!;
    if (method === 'GET' && service === 'info/refs') {
      handleInfoRefs(ctx, gitMatch[1]!, gitMatch[2]!, url.searchParams.get('service') ?? 'git-upload-pack');
      return;
    }
    if (method === 'POST' && service === 'git-upload-pack') { handleUploadPack(ctx, gitMatch[1]!, gitMatch[2]!); return; }
    if (method === 'POST' && service === 'git-receive-pack') { handleReceivePack(ctx, gitMatch[1]!, gitMatch[2]!); return; }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // GraphQL v4
  if (rawPath === '/api/graphql' || rawPath === '/api/graphql/') {
    if (method !== 'POST') { sendError(ctx, 405, 'Method Not Allowed'); return; }
    handleGraphQL(ctx, authed);
    return;
  }

  // MCP
  if (rawPath === '/mcp' || rawPath === '/mcp/') {
    if (method !== 'POST') { sendError(ctx, 405, 'Method Not Allowed'); return; }
    handleMcp(ctx, authed);
    return;
  }

  // REST v3
  if (rawPath === '/api/v3' || rawPath.startsWith('/api/v3/')) {
    if (!authed) {
      sendJson(ctx, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    const subpath = rawPath.slice('/api/v3'.length);
    await handleApiV3(ctx, subpath);
    return;
  }

  // everything else: GitHub's 404
  sendJson(ctx, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}
