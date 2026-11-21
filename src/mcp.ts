// Model Context Protocol over streamable HTTP at /mcp — both eras: modern server/discover
// (2026-07-28) and the legacy initialize handshake. Tools write through the same store as REST.
import { store, Repo, VIEWER, Issue, Pull } from './store.ts';
import { Ctx } from './rest.ts';
import { buildTree, buildCommit } from './gitobj.ts';

const PREFERRED = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CLIENT_INFO = { name: 'makefun-github-core-clone-env', version: '1.0.0' };

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const MCP_UNSUPPORTED_VERSION = -32022;

interface RpcReq { id: string | number | null; method: string; params: Record<string, unknown>; meta: Record<string, unknown>; headerVersion: string | null; }

function serverInfo(): Record<string, unknown> {
  return { name: 'entry-forge', version: '1.0.0' };
}

function toolsList(): Record<string, unknown>[] {
  const t = (name: string, description: string, props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
    name,
    title: name.replace(/_/g, ' '),
    description,
    inputSchema: { type: 'object', properties: props, required },
  });
  return [
    t('create_repo', 'Create a repository owned by the authenticated viewer', { name: { type: 'string' }, private: { type: 'boolean' }, description: { type: 'string' }, auto_init: { type: 'boolean' } }, ['name']),
    t('get_repo', 'Read one repository', { owner: { type: 'string' }, repo: { type: 'string' } }, ['owner', 'repo']),
    t('create_issue', 'Create an issue in a repository', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, ['owner', 'repo', 'title']),
    t('list_issues', 'List issues of a repository', { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, ['owner', 'repo']),
    t('get_issue', 'Read one issue by number', { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'number' } }, ['owner', 'repo', 'number']),
    t('create_pull_request', 'Open a pull request', { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, ['owner', 'repo', 'title', 'head', 'base']),
    t('merge_pull_request', 'Merge a pull request (squash by default)', { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'number' }, merge_method: { type: 'string' } }, ['owner', 'repo', 'number']),
    t('list_pull_requests', 'List pull requests of a repository', { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, ['owner', 'repo']),
  ];
}

function findRepo(owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  const name = repo.replace(/\.git$/, '');
  return store.getRepo(owner, name);
}

function repoOfArg(args: Record<string, unknown>): Repo | null {
  const direct = findRepo(args['owner'], args['repo'] ?? args['repository'] ?? args['name']);
  if (direct) return direct;
  const full = typeof args['repository'] === 'string' && args['repository'].includes('/')
    ? args['repository'].split('/') : null;
  if (full) return store.getRepo(full[0]!, full[1]!.replace(/\.git$/, ''));
  return null;
}

function toolResult(payload: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(payload, null, 1);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false, resultType: 'tool_result' };
}

function runTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const clean = name.toLowerCase().replace(/^(server|forge)[-_]/, '');
  const missing = (need: string[]): boolean => need.some((k) => args[k] === undefined || args[k] === null || args[k] === '');

  if (clean.endsWith('create_repo')) {
    if (missing(['name'])) return { content: [{ type: 'text', text: 'missing required argument: name' }], isError: true };
    const nm = String(args['name']);
    const existing = store.getRepo(VIEWER.login, nm);
    if (existing) return toolResult({ error: 'name already exists on this account', full_name: `${VIEWER.login}/${nm}` });
    const repo = store.createRepo(nm, args['private'] === true, String(args['description'] ?? ''));
    if (args['auto_init'] === true) {
      const data = Buffer.from(`# ${nm}\n`, 'utf8');
      initialCommit(repo, 'README.md', data);
    }
    return toolResult({ full_name: `${repo.owner}/${repo.name}`, name: repo.name, private: repo.isPrivate, default_branch: repo.defaultBranch, html_url: `${repo.owner}/${repo.name}` });
  }
  if (clean.endsWith('get_repo')) {
    const repo = repoOfArg(args);
    if (!repo) return { content: [{ type: 'text', text: 'repository not found' }], isError: true };
    return toolResult({ full_name: `${repo.owner}/${repo.name}`, name: repo.name, description: repo.description, private: repo.isPrivate, default_branch: repo.defaultBranch });
  }
  if (clean.endsWith('create_issue')) {
    const repo = repoOfArg(args);
    if (!repo || missing(['title'])) return { content: [{ type: 'text', text: 'missing required arguments: owner, repo, title' }], isError: true };
    const labelsIn = Array.isArray(args['labels']) ? args['labels'] as string[] : [];
    for (const l of labelsIn) if (!repo.labels.has(l)) return { content: [{ type: 'text', text: `Label "${l}" does not exist` }], isError: true };
    const t = store.nowIso();
    const issue: Issue = { number: ++repo.issueSeq, title: String(args['title']), body: String(args['body'] ?? ''), state: 'open', labels: labelsIn, user: VIEWER, createdAt: t, updatedAt: t, closedAt: null, comments: [], commentSeq: 0 };
    repo.issues.set(issue.number, issue);
    return toolResult({ number: issue.number, title: issue.title, state: 'open', url: `${repo.owner}/${repo.name}/issues/${issue.number}` });
  }
  if (clean.endsWith('list_issues')) {
    const repo = repoOfArg(args);
    if (!repo) return { content: [{ type: 'text', text: 'repository not found' }], isError: true };
    const state = String(args['state'] ?? 'open');
    const issues = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
    return toolResult({ issues: issues.map((i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels })) });
  }
  if (clean.endsWith('get_issue')) {
    const repo = repoOfArg(args);
    const n = Number(args['number']);
    if (!repo || !Number.isInteger(n) || !repo.issues.get(n)) return { content: [{ type: 'text', text: 'issue not found' }], isError: true };
    const i = repo.issues.get(n)!;
    return toolResult({ number: i.number, title: i.title, body: i.body, state: i.state });
  }
  if (clean.endsWith('create_pull_request')) {
    const repo = repoOfArg(args);
    if (!repo || missing(['title', 'head', 'base'])) return { content: [{ type: 'text', text: 'missing required arguments: owner, repo, title, head, base' }], isError: true };
    const head = String(args['head']);
    const base = String(args['base']);
    const headSha = repo.branchSha(head);
    const baseSha = repo.branchSha(base);
    if (headSha === undefined) return { content: [{ type: 'text', text: `head ref '${head}' cannot be resolved` }], isError: true };
    const t = store.nowIso();
    const pull: Pull = {
      number: ++repo.issueSeq, title: String(args['title']), body: String(args['body'] ?? ''), state: 'open',
      headRef: head, baseRef: base, headSha, baseSha: baseSha ?? headSha, merged: false, mergedAt: null,
      mergeCommitSha: null, mergeable: true, files: store.diffTrees(repo, baseSha ?? headSha, headSha),
      user: VIEWER, createdAt: t, updatedAt: t, closedAt: null,
    };
    repo.pulls.set(pull.number, pull);
    return toolResult({ number: pull.number, state: 'open', headRefName: head, baseRefName: base, title: pull.title });
  }
  if (clean.endsWith('merge_pull_request')) {
    const repo = repoOfArg(args);
    const n = Number(args['number']);
    if (!repo || !Number.isInteger(n) || !repo.pulls.get(n)) return { content: [{ type: 'text', text: 'pull request not found' }], isError: true };
    const pull = repo.pulls.get(n)!;
    if (pull.merged) return { content: [{ type: 'text', text: 'Pull Request is not mergeable' }], isError: true };
    const result = store.mergePull(repo, pull, pull.title || `Merge pull request #${pull.number}`);
    if (result === 'conflict') return { content: [{ type: 'text', text: 'Pull Request is not mergeable' }], isError: true };
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = result;
    pull.closedAt = pull.mergedAt;
    return toolResult({ merged: true, sha: result, number: pull.number });
  }
  if (clean.endsWith('list_pull_requests')) {
    const repo = repoOfArg(args);
    if (!repo) return { content: [{ type: 'text', text: 'repository not found' }], isError: true };
    const state = String(args['state'] ?? 'open');
    const pulls = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state);
    return toolResult({ pulls: pulls.map((p) => ({ number: p.number, title: p.title, state: p.merged ? 'merged' : p.state, headRefName: p.headRef, baseRefName: p.baseRef })) });
  }
  return null; // unknown tool
}

function initialCommit(repo: Repo, path: string, data: Buffer): void {
  const blobSha = repo.putObject({ type: 'blob', data });
  const tree = buildTree([{ path, oid: blobSha, mode: '100644' }]);
  repo.putObject({ type: 'tree', data: tree.data }, tree.oid);
  const commit = buildCommit({ tree: tree.oid, parents: [], message: 'Initial commit', authorName: VIEWER.name, authorEmail: VIEWER.email, ts: store.nowUnix() });
  repo.putObject({ type: 'commit', data: commit.data }, commit.oid);
  repo.setBranch(repo.defaultBranch, commit.oid);
}

// ---------------------------------------------------------------- JSON-RPC handling

function rpcResult(id: string | number | null, result: unknown, extraHeaders: Record<string, string> = {}): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  return { status: 200, body: { jsonrpc: '2.0', id, result }, headers: extraHeaders };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err['data'] = data;
  return { status: 200, body: { jsonrpc: '2.0', id, error: err }, headers: {} };
}

function handleRpc(req: RpcReq): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  const id = req.id;
  const requestedVersion = String(req.meta['io.modelcontextprotocol/protocolVersion'] ?? req.params['protocolVersion'] ?? req.headerVersion ?? '');
  if (requestedVersion !== '' && requestedVersion !== PREFERRED && !LEGACY_REVISIONS.includes(requestedVersion)) {
    return rpcError(id, MCP_UNSUPPORTED_VERSION, `Unsupported protocol version ${requestedVersion}`, { supported: [PREFERRED, ...LEGACY_REVISIONS] });
  }

  if (req.method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'server_discover',
      supportedVersions: [PREFERRED],
      capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
      instructions: 'GitHub-compatible forge tools; use tools/list and tools/call.',
      serverInfo: serverInfo(),
    });
  }

  if (req.method === 'initialize') {
    const offered = String(req.params['protocolVersion'] ?? PREFERRED);
    const chosen = LEGACY_REVISIONS.includes(offered) || offered === PREFERRED ? offered : PREFERRED;
    return rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: { listChanged: false } },
      serverInfo: serverInfo(),
      instructions: 'GitHub-compatible forge tools.',
    }, { 'mcp-session-id': 'sess-entry-forge-1' });
  }

  if (req.method === 'notifications/initialized' || req.method.startsWith('notifications/')) {
    return { status: 202, body: {}, headers: {} };
  }

  if (req.method === 'tools/list') {
    return rpcResult(id, { tools: toolsList() });
  }

  if (req.method === 'tools/call') {
    const params = req.params as Record<string, unknown>;
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    if (name === '') return rpcError(id, JSON_RPC_INVALID_PARAMS, 'tools/call needs a tool name');
    const result = runTool(name, args);
    if (result === null) {
      return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
    }
    return rpcResult(id, result);
  }

  return rpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
}

/** POST /mcp — JSON body (single object or batch) or SSE answer. */
export function handleMcp(ctx: Ctx, authenticated: boolean): void {
  if (!authenticated) {
    ctx.res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.requestId });
    ctx.res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a valid bearer token is required.' } })}\n`);
    return;
  }
  const text = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    ctx.res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.requestId });
    ctx.res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Invalid JSON body' } })}\n`);
    return;
  }
  const headerVersion = ctx.req.headers['mcp-protocol-version'];
  const methodHeader = ctx.req.headers['mcp-method'];
  const toReq = (raw: Record<string, unknown>): RpcReq => {
    const params = (raw['params'] ?? {}) as Record<string, unknown>;
    const meta = (params['_meta'] ?? {}) as Record<string, unknown>;
    const method = typeof raw['method'] === 'string' ? raw['method'] : '';
    void methodHeader;
    return { id: (raw['id'] ?? null) as string | number | null, method, params, meta, headerVersion: typeof headerVersion === 'string' ? headerVersion : null };
  };
  if (Array.isArray(parsed)) {
    const answers = parsed.filter((e) => e !== null && typeof e === 'object' && typeof (e as Record<string, unknown>)['method'] === 'string')
      .map((e) => handleRpc(toReq(e as Record<string, unknown>)));
    if (answers.length === 0) { ctx.res.writeHead(202); ctx.res.end(); return; }
    ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.requestId });
    ctx.res.end(`${JSON.stringify(answers.map((a) => a.body))}\n`);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>)['method'] !== 'string') {
    const answer = rpcError(null, JSON_RPC_PARSE_ERROR, 'The request is not a JSON-RPC 2.0 object');
    ctx.res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.requestId });
    ctx.res.end(`${JSON.stringify(answer.body)}\n`);
    return;
  }
  const req = toReq(parsed as Record<string, unknown>);
  const isNotification = req.id === null || req.id === undefined;
  const answer = handleRpc(req);
  if (answer.status === 202 || isNotification) {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  ctx.res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8', ...answer.headers, 'x-github-request-id': ctx.requestId });
  ctx.res.end(`${JSON.stringify(answer.body)}\n`);
}
