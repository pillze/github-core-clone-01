// REST v3 API under /api/v3 — repos, issues, labels, comments, pulls, contents, git refs.
// Shapes follow the GitHub REST v3 endpoints the suite's checks drive.
import { IncomingMessage, ServerResponse } from 'node:http';
import { store, Store, Repo, VIEWER, STRANGER, Pull, Issue } from './store.ts';
import { buildTree, buildCommit, shaOfObject } from './gitobj.ts';

export { store };

// ---------------------------------------------------------------- helpers

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: Buffer;
  requestId: string;
}

export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const h: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.requestId,
    'x-github-media-type': 'github.v3; format=json',
    ...headers,
  };
  ctx.res.writeHead(status, h);
  ctx.res.end(text);
}

export function errorBody(message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { message, documentation_url: 'https://docs.github.com/rest', ...extra };
}

export function sendError(ctx: Ctx, status: number, message: string, extra?: Record<string, unknown>): void {
  sendJson(ctx, status, errorBody(message, extra));
}

function readJson(ctx: Ctx): Record<string, unknown> | null {
  try {
    const text = ctx.body.toString('utf8');
    if (text.trim() === '') return {};
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }
function bool(v: unknown): boolean | undefined { return typeof v === 'boolean' ? v : undefined; }

function ownerUrl(owner: string, name: string): string { return `/api/v3/repos/${owner}/${name}`; }

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repoId(repo),
    node_id: b64(`repository:${repoId(repo)}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(USERS.get(repo.owner) ?? VIEWER),
    html_url: `${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: ownerUrl(repo.owner, repo.name),
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    size: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

let repoIds = new Map<string, number>();
function repoId(repo: Repo): number {
  const k = `${repo.owner}/${repo.name}`;
  let id = repoIds.get(k);
  if (id === undefined) { id = 5000 + repoIds.size; repoIds.set(k, id); }
  return id;
}

function userJson(u: { id: number; login: string; name: string; email: string }): Record<string, unknown> {
  return { login: u.login, id: u.id, node_id: b64(`user:${u.id}`), name: u.name, email: u.email, type: 'User', url: `/api/v3/users/${u.login}` };
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number + 40000,
    node_id: b64(`issue:${repo.owner}/${repo.name}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: null })),
    user: userJson(issue.user),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${ownerUrl(repo.owner, repo.name)}/issues/${issue.number}`,
    html_url: `${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: ownerUrl(repo.owner, repo.name),
    author_association: 'OWNER',
  };
}

function labelJson(label: { name: string; color: string; description: string | null }): Record<string, unknown> {
  return { id: hashId(label.name), node_id: b64(`label:${label.name}`), name: label.name, color: label.color, description: label.description, default: false, url: `/api/v3/repos/.../labels/${label.name}` };
}

function hashId(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return Math.abs(h) % 900000;
}

function commentJson(repo: Repo, issueNumber: number, c: { id: number; body: string; user: { id: number; login: string; name: string; email: string }; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: c.id,
    node_id: b64(`comment:${repo.owner}/${repo.name}/${issueNumber}/${c.id}`),
    body: c.body,
    user: userJson(c.user),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    issue_url: `${ownerUrl(repo.owner, repo.name)}/issues/${issueNumber}`,
    html_url: `${repo.owner}/${repo.name}/issues/${issueNumber}#comment-${c.id}`,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number + 80000,
    node_id: b64(`pull:${repo.owner}/${repo.name}/${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? null : pull.mergeable,
    draft: false,
    user: userJson(pull.user),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${pull.user.login}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.merged ? pull.baseSha : (repo.branchSha(pull.baseRef) ?? pull.baseSha), label: `${pull.user.login}:${pull.baseRef}`, repo: repoJson(repo) },
    files_url: `${ownerUrl(repo.owner, repo.name)}/pulls/${pull.number}/files`,
    commits_url: `${ownerUrl(repo.owner, repo.name)}/pulls/${pull.number}/commits`,
    url: `${ownerUrl(repo.owner, repo.name)}/pulls/${pull.number}`,
    html_url: `${repo.owner}/${repo.name}/pull/${pull.number}`,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    author_association: 'OWNER',
  };
}

function commitJson(repo: Repo, sha: string, parsed: { message: string; author: string; committer: string; ts: number; parents: string[] }): Record<string, unknown> {
  return {
    sha,
    node_id: b64(`commit:${sha}`),
    commit: {
      message: parsed.message,
      author: commitUser(parsed.author, parsed.ts),
      committer: commitUser(parsed.committer, parsed.ts),
      tree: { sha: shaOfObject('tree', Buffer.alloc(0)), url: `${ownerUrl(repo.owner, repo.name)}/git/trees/` },
      url: `${ownerUrl(repo.owner, repo.name)}/git/commits/${sha}`,
    },
    url: `${ownerUrl(repo.owner, repo.name)}/commits/${sha}`,
    html_url: `${repo.owner}/${repo.name}/commit/${sha}`,
    parents: parsed.parents.map((p) => ({ sha: p, url: `${ownerUrl(repo.owner, repo.name)}/commits/${p}` })),
  };
}

function commitUser(line: string, ts: number): Record<string, unknown> {
  const m = /^(.*?)\s+<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/.exec(line);
  if (!m) return { name: 'Entry Forge', email: 'forge@entry.invalid', date: new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  return { name: m[1], email: m[2], date: new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function repoRef(ctx: Ctx, parts: string[]): { repo: Repo; owner: string; name: string } | null {
  const owner = parts[0] ?? '';
  const name = parts[1] ?? '';
  const repo = store.getRepo(owner, name);
  return repo ? { repo, owner, name } : null;
}

function baseUrlOf(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Commit a file change (create/update/delete) on a branch; returns the new commit sha. */
function commitFileChange(repo: Repo, branch: string, path: string, data: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
  const tip = repo.branchSha(branch);
  const listing = tip ? repo.listTree(tip) : new Map<string, { oid: string; mode: string }>();
  let blobSha: string | null = null;
  if (data === null) listing.delete(path);
  else {
    blobSha = repo.putObject({ type: 'blob', data });
    listing.set(path, { oid: blobSha, mode: '100644' });
  }
  const tree = buildTree([...listing].map(([p, e]) => ({ path: p, oid: e.oid, mode: e.mode })));
  repo.putObject({ type: 'tree', data: tree.data }, tree.oid);
  const commit = buildCommit({
    tree: tree.oid,
    parents: tip ? [tip] : [],
    message,
    authorName: VIEWER.name,
    authorEmail: VIEWER.email,
    ts: store.nowUnix(),
  });
  repo.putObject({ type: 'commit', data: commit.data }, commit.oid);
  repo.setBranch(branch, commit.oid);
  return { commitSha: commit.oid, blobSha };
}

// ---------------------------------------------------------------- routing

function splitPath(subpath: string): string[] {
  return subpath.split('/').filter((p) => p !== '');
}

export async function handleApiV3(ctx: Ctx, subpath: string): Promise<boolean> {
  const parts = splitPath(subpath);
  const method = (ctx.req.method ?? 'GET').toUpperCase();
  const json = (): Record<string, unknown> | null => readJson(ctx);

  // root & meta
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, {
        current_user_url: '/api/v3/user',
        authorizations_url: '/api/v3/authorizations',
        user_url: '/api/v3/users/{user}',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        pulls_url: '/api/v3/pulls{?number}',
        meta_url: '/api/v3/meta',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' });
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  if (parts[0] === 'meta' && parts.length === 1 && method === 'GET') {
    sendJson(ctx, 200, {
      verifiable_password_authentication: false,
      installed_version: '3.6.0-entry.1',
      packages_disabled: false,
      ssh_key_fingerprints: {},
      hooks: [],
      verifiable_password_authentication_github_enterprise: false,
      actions: '/',
      pages: '/',
    });
    return true;
  }

  if (parts[0] === 'user') {
    if (parts.length === 1 && method === 'GET') { sendJson(ctx, 200, userJson(VIEWER)); return true; }
    if (parts[1] === 'repos' && parts.length === 2) {
      if (method === 'GET') return listViewerRepos(ctx), true;
      if (method === 'POST') return createRepo(ctx, json()), true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const ref = repoRef(ctx, parts.slice(1));
    if (!ref) { sendError(ctx, 404, 'Not Found'); return true; }
    const { repo } = ref;
    const rest = parts.slice(3);
    const base = `${ownerUrl(repo.owner, repo.name)}`;

    if (rest.length === 0) {
      if (method === 'GET') { sendJson(ctx, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') return patchRepo(ctx, repo, json()), true;
      if (method === 'DELETE') {
        store.repos.delete(`${repo.owner}/${repo.name}`);
        ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
        ctx.res.end();
        return true;
      }
      sendError(ctx, 404, 'Not Found');
      return true;
    }

    const head0 = rest[0]!;
    if (head0 === 'branches' && method === 'GET' && rest.length === 1) return listBranches(ctx, repo), true;
    if (head0 === 'branches' && rest.length === 2 && method === 'GET') {
      const branch = rest[1]!;
      const sha = repo.branchSha(branch);
      if (sha === undefined) { sendError(ctx, 404, 'Branch not found'); return true; }
      sendJson(ctx, 200, branchJson(repo, branch, sha));
      return true;
    }
    if (head0 === 'commits' && method === 'GET') return listCommits(ctx, repo, ctx.url.searchParams), true;
    if (head0 === 'contents') return handleContents(ctx, repo, rest.slice(1), method);
    if (head0 === 'issues') return handleIssues(ctx, repo, rest.slice(1), method, json());
    if (head0 === 'labels') return handleLabels(ctx, repo, rest.slice(1), method, json());
    if (head0 === 'pulls') return handlePulls(ctx, repo, rest.slice(1), method, json());
    if (head0 === 'git' && rest[1] === 'refs') return handleGitRefs(ctx, repo, rest.slice(2), method, json());
    if (head0 === 'git' && rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
      const sha = rest[2]!.toLowerCase();
      const obj = repo.objects.get(sha);
      if (!obj) { sendError(ctx, 422, `No commit found for SHA: ${sha}`); return true; }
      sendJson(ctx, 200, {
        sha,
        node_id: b64(`commit:${sha}`),
        commit: { message: obj.data.toString('utf8') },
        url: `${base}/git/commits/${sha}`,
        html_url: `${repo.owner}/${repo.name}/commit/${sha}`,
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
        parents: [],
      });
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  sendError(ctx, 404, 'Not Found');
  return true;
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, commit: { message: '', url: `${ownerUrl(repo.owner, repo.name)}/git/commits/${sha}` }, url: `${ownerUrl(repo.owner, repo.name)}/commits/${sha}` },
    protected: false,
    required_status_checks: null,
  };
}

function listBranches(ctx: Ctx, repo: Repo): void {
  const branches = [...repo.refs.keys()]
    .filter((r) => r.startsWith('refs/heads/'))
    .map((r) => r.slice('refs/heads/'.length))
    .sort();
  sendJson(ctx, 200, branches.map((b) => branchJson(repo, b, repo.branchSha(b)!)));
}

function listCommits(ctx: Ctx, repo: Repo, query: URLSearchParams): void {
  const branch = query.get('sha') ?? query.get('ref') ?? repo.defaultBranch;
  const tip = repo.branchSha(branch);
  if (tip === undefined) { sendError(ctx, 404, `SHA could not be resolved to a commit for branch ${branch}`); return; }
  const commits = repo.walkCommits(tip);
  sendJson(ctx, 200, commits.map((c) => commitJson(repo, c.sha, c.commit)));
}

function patchRepo(ctx: Ctx, repo: Repo, body: Record<string, unknown> | null): void {
  if (body === null) { sendError(ctx, 400, 'Problems parsing JSON'); return; }
  if (body.description !== undefined) repo.description = str(body.description);
  if (body.name !== undefined && str(body.name) !== '') repo.name = str(body.name);
  if (body.private !== undefined && bool(body.private) !== undefined) repo.isPrivate = bool(body.private)!;
  repo.updatedAt = store.nowIso();
  sendJson(ctx, 200, repoJson(repo));
}

function listViewerRepos(ctx: Ctx): void {
  const query = ctx.url.searchParams;
  const perPage = Math.min(Math.max(Number(query.get('per_page') ?? 30) || 30, 1), 100);
  const page = Math.max(Number(query.get('page') ?? 1) || 1, 1);
  const repos = store.viewerRepos();
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const links: string[] = [];
  const mk = (p: number): string => `${baseUrlOf(ctx)}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
  if (start + perPage < repos.length) links.push(`<${mk(page + 1)}>; rel="next"`);
  if (repos.length > 0) links.push(`<${mk(Math.max(Math.ceil(repos.length / perPage), 1))}>; rel="last"`);
  if (page > 1) links.push(`<${mk(page - 1)}>; rel="prev"`, `<${mk(1)}>; rel="first"`);
  const headers = links.length > 0 ? { link: links.join(', ') } : {};
  sendJson(ctx, 200, slice.map(repoJson), headers);
}

function createRepo(ctx: Ctx, body: Record<string, unknown> | null): void {
  if (body === null) { sendError(ctx, 400, 'Problems parsing JSON'); return; }
  const name = str(body.name).trim();
  if (name === '') { sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] }); return; }
  const isPrivate = bool(body.private) ?? false;
  const description = str(body.description ?? '');
  const existing = store.getRepo(VIEWER.login, name);
  if (existing) { sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] }); return; }
  const repo = store.createRepo(name, isPrivate, description);
  if (bool(body.auto_init) === true) {
    const data = Buffer.from(`# ${name}\n`, 'utf8');
    commitFileChange(repo, repo.defaultBranch, 'README.md', data, 'Initial commit');
  }
  sendJson(ctx, 201, repoJson(repo));
}

// ---------------------------------------------------------------- contents

function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (!ref) return repo.branchSha(repo.defaultBranch);
  return repo.branchSha(ref) ?? repo.refSha(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
}

function contentFileJson(repo: Repo, path: string, entry: { oid: string; mode: string }): Record<string, unknown> {
  const obj = repo.objects.get(entry.oid)!;
  return {
    name: path.split('/').pop(),
    path,
    sha: entry.oid,
    size: obj.data.length,
    type: 'file',
    url: `${ownerUrl(repo.owner, repo.name)}/contents/${path}?ref=${repo.defaultBranch}`,
    git_url: `${ownerUrl(repo.owner, repo.name)}/git/blobs/${entry.oid}`,
    html_url: `${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: `/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    content: obj.data.toString('base64'),
    encoding: 'base64',
    _links: { self: `${ownerUrl(repo.owner, repo.name)}/contents/${path}`, git: `${ownerUrl(repo.owner, repo.name)}/git/blobs/${entry.oid}`, html: `${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}` },
  };
}

function handleContents(ctx: Ctx, repo: Repo, pathParts: string[], method: string): void {
  const path = pathParts.join('/');
  const body = method === 'GET' ? null : readJson(ctx);
  if (method !== 'GET' && body === null) { sendError(ctx, 400, 'Problems parsing JSON'); return; }
  const query = ctx.url.searchParams;
  const refName = query.get('ref');

  if (method === 'GET') {
    const tip = resolveRef(repo, refName);
    if (tip === undefined) { sendError(ctx, 404, 'No commit found for the ref'); return; }
    const listing = repo.listTree(tip);
    if (listing.has(path)) {
      sendJson(ctx, 200, contentFileJson(repo, path, listing.get(path)!));
      return;
    }
    const dirPrefix = path === '' ? '' : `${path}/`;
    const children = [...listing.entries()].filter(([p]) => p.startsWith(dirPrefix));
    if (children.length > 0 || path === '') {
      const names = new Set<string>();
      for (const [p] of children) {
        const rest = p.slice(dirPrefix.length);
        names.add(rest.includes('/') ? `${rest.slice(0, rest.indexOf('/'))}/` : rest);
      }
      const entries = [...names].sort().map((n) => {
        const isDir = n.endsWith('/');
        const clean = isDir ? n.slice(0, -1) : n;
        const full = dirPrefix + clean;
        const entry = listing.get(full);
        return entry
          ? contentFileJson(repo, full, entry)
          : {
              name: clean, path: full, sha: shaOfObject('tree', Buffer.alloc(0)), size: 0, type: 'dir',
              url: `${ownerUrl(repo.owner, repo.name)}/contents/${full}?ref=${repo.defaultBranch}`,
              git_url: `${ownerUrl(repo.owner, repo.name)}/git/trees/`, html_url: `${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${full}`,
              download_url: null, content: null, encoding: null, _links: {},
            };
      });
      sendJson(ctx, 200, entries);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (method === 'PUT') {
    const branch = str(body!.branch ?? '') || repo.defaultBranch;
    if (repo.branchSha(branch) === undefined && repo.branchSha(repo.defaultBranch) !== undefined && str(body!.branch ?? '') !== '') {
      // GitHub answers 404 for a missing branch
      sendError(ctx, 404, 'Branch not found');
      return;
    }
    const contentB64 = str(body!.content ?? '').replace(/\s+/g, '');
    const data = Buffer.from(contentB64, 'base64');
    const tip = repo.branchSha(branch);
    const listing = tip ? repo.listTree(tip) : new Map<string, { oid: string; mode: string }>();
    const existing = listing.get(path);
    const givenSha = str(body!.sha ?? '');
    if (existing !== undefined && givenSha === '' && tip !== undefined) {
      sendError(ctx, 422, `${path} already exists`, { errors: [{ resource: 'Contents', field: 'sha', code: 'missing_field' }] });
      return;
    }
    if (existing !== undefined && givenSha !== '' && givenSha.toLowerCase() !== existing.oid) {
      sendError(ctx, 409, `${path} does not match ${givenSha}`);
      return;
    }
    if (existing === undefined && givenSha !== '') {
      sendError(ctx, 409, `${path} does not exist`);
      return;
    }
    const message = str(body!.message ?? 'Update file');
    const { commitSha, blobSha } = commitFileChange(repo, branch, path, data, message);
    sendJson(ctx, tip === undefined ? 201 : 201, {
      content: {
        name: path.split('/').pop(), path, sha: blobSha, size: data.length, type: 'file',
        url: `${ownerUrl(repo.owner, repo.name)}/contents/${path}?ref=${branch}`,
        git_url: `${ownerUrl(repo.owner, repo.name)}/git/blobs/${blobSha}`,
        html_url: `${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        download_url: `/${repo.owner}/${repo.name}/raw/${branch}/${path}`,
        content: data.toString('base64'), encoding: 'base64', _links: {},
      },
      commit: {
        sha: commitSha,
        node_id: b64(`commit:${commitSha}`),
        commit: { message, author: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso() }, committer: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso() }, tree: { sha: '', url: '' }, url: `${ownerUrl(repo.owner, repo.name)}/git/commits/${commitSha}` },
        url: `${ownerUrl(repo.owner, repo.name)}/git/commits/${commitSha}`,
        html_url: `${repo.owner}/${repo.name}/commit/${commitSha}`,
        parents: [],
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
      },
    });
    return;
  }

  if (method === 'DELETE') {
    const branch = str(body!.branch ?? '') || repo.defaultBranch;
    const tip = repo.branchSha(branch);
    if (tip === undefined) { sendError(ctx, 404, 'Branch not found'); return; }
    const listing = repo.listTree(tip);
    const existing = listing.get(path);
    if (!existing) { sendError(ctx, 404, 'Not Found'); return; }
    const givenSha = str(body!.sha ?? '');
    if (givenSha !== '' && givenSha.toLowerCase() !== existing.oid) {
      sendError(ctx, 409, `${path} does not match ${givenSha}`);
      return;
    }
    const message = str(body!.message ?? 'Delete file');
    const { commitSha } = commitFileChange(repo, branch, path, null, message);
    sendJson(ctx, 200, {
      content: null,
      commit: {
        sha: commitSha,
        node_id: b64(`commit:${commitSha}`),
        commit: { message, author: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso() }, committer: { name: VIEWER.name, email: VIEWER.email, date: store.nowIso() }, tree: { sha: '', url: '' }, url: '' },
        url: `${ownerUrl(repo.owner, repo.name)}/git/commits/${commitSha}`,
        html_url: `${repo.owner}/${repo.name}/commit/${commitSha}`,
        parents: [],
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
      },
    });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- git refs

function handleGitRefs(ctx: Ctx, repo: Repo, parts: string[], method: string, body: Record<string, unknown> | null): void {
  if (method === 'POST' && parts.length === 0) {
    const ref = str(body!.ref ?? '');
    const sha = str(body!.sha ?? '').toLowerCase();
    if (!ref.startsWith('refs/')) { sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'GitReference', field: 'ref', code: 'custom', message: 'Reference name is not well-formed' }] }); return; }
    if (!repo.objects.has(sha)) { sendError(ctx, 422, 'Object does not exist'); return; }
    if (repo.refs.has(ref)) { sendError(ctx, 422, 'Reference already exists'); return; }
    repo.refs.set(ref, sha);
    sendJson(ctx, 201, {
      ref,
      node_id: b64(`ref:${ref}`),
      url: `${ownerUrl(repo.owner, repo.name)}/git/refs/${encodeURIComponent(ref)}`,
      object: { sha, type: 'commit', url: `${ownerUrl(repo.owner, repo.name)}/git/commits/${sha}` },
    });
    return;
  }
  if (method === 'GET' && parts.length >= 1) {
    const refName = parts.join('/').replace(/%2F/g, '/');
    const sha = repo.refs.get(refName) ?? repo.refs.get(`refs/${refName}`);
    if (sha === undefined) { sendError(ctx, 404, 'Not Found'); return; }
    sendJson(ctx, 200, {
      ref: refName.startsWith('refs/') ? refName : `refs/${refName}`,
      node_id: b64(`ref:${refName}`),
      url: `${ownerUrl(repo.owner, repo.name)}/git/refs/${refName}`,
      object: { sha, type: 'commit', url: `${ownerUrl(repo.owner, repo.name)}/git/commits/${sha}` },
    });
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- issues & labels

function handleLabels(ctx: Ctx, repo: Repo, parts: string[], method: string, body: Record<string, unknown> | null): void {
  if (parts.length === 0 && method === 'GET') {
    sendJson(ctx, 200, [...repo.labels.values()].map(labelJson));
    return;
  }
  if (parts.length === 0 && method === 'POST') {
    const name = str(body!.name ?? '').trim();
    if (name === '') { sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] }); return; }
    const label = { name, color: str(body!.color ?? 'ededed') || 'ededed', description: body!.description === undefined ? null : str(body!.description) };
    repo.labels.set(name, label);
    sendJson(ctx, 201, labelJson(label));
    return;
  }
  if (parts.length === 1 && method === 'GET') {
    const label = repo.labels.get(parts[0]!);
    if (!label) { sendError(ctx, 404, 'Label does not exist'); return; }
    sendJson(ctx, 200, labelJson(label));
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

function handleIssues(ctx: Ctx, repo: Repo, parts: string[], method: string, body: Record<string, unknown> | null): void {
  // /issues  and /issues/{n} and /issues/{n}/comments
  if (parts.length === 0) {
    if (method === 'GET') {
      const query = ctx.url.searchParams;
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
      issues.sort((a, b) => sort === 'created' || sort === 'updated'
        ? (direction === 'asc' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt))
        : b.number - a.number);
      sendJson(ctx, 200, issues.map((i) => issueJson(repo, i)));
      return;
    }
    if (method === 'POST') {
      const title = str(body!.title ?? '');
      if (title === '') { sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] }); return; }
      const labelsIn = Array.isArray(body!.labels) ? (body!.labels as unknown[]).map((l) => typeof l === 'string' ? l : str((l as Record<string, unknown>).name)).filter((l) => l !== '') : [];
      for (const l of labelsIn) {
        if (!repo.labels.has(l)) {
          sendError(ctx, 422, `Validation Failed`, { errors: [{ resource: 'Issue', field: 'labels', code: 'custom', message: `Label "${l}" does not exist` }] });
          return;
        }
      }
      const t = store.nowIso();
      const issue: Issue = {
        number: ++repo.issueSeq,
        title,
        body: str(body!.body ?? ''),
        state: 'open',
        labels: labelsIn,
        user: VIEWER,
        createdAt: t,
        updatedAt: t,
        closedAt: null,
        comments: [],
        commentSeq: 0,
      };
      repo.issues.set(issue.number, issue);
      sendJson(ctx, 201, issueJson(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const n = Number(parts[0]);
  const issue = Number.isInteger(n) ? repo.issues.get(n) : undefined;
  if (!issue) { sendError(ctx, 404, 'Not Found'); return; }

  if (parts.length === 1 && method === 'GET') { sendJson(ctx, 200, issueJson(repo, issue)); return; }
  if (parts.length === 1 && method === 'PATCH') {
    if (body!.title !== undefined) issue.title = str(body!.title);
    if (body!.body !== undefined) issue.body = str(body!.body);
    if (body!.state !== undefined) {
      const state = str(body!.state);
      if (state === 'open' || state === 'closed') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? store.nowIso() : null;
      }
    }
    issue.updatedAt = store.nowIso();
    sendJson(ctx, 200, issueJson(repo, issue));
    return;
  }
  if (parts[1] === 'comments') {
    if (parts.length === 2 && method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((c) => commentJson(repo, issue.number, c)));
      return;
    }
    if (parts.length === 2 && method === 'POST') {
      const text = str(body!.body ?? '');
      if (text === '') { sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] }); return; }
      const t = store.nowIso();
      const comment = { id: ++repo.commentIdSeq, body: text, user: VIEWER, createdAt: t, updatedAt: t };
      issue.comments.push(comment);
      issue.updatedAt = t;
      sendJson(ctx, 201, commentJson(repo, issue.number, comment));
      return;
    }
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function handlePulls(ctx: Ctx, repo: Repo, parts: string[], method: string, body: Record<string, unknown> | null): void {
  if (parts.length === 0) {
    if (method === 'GET') {
      const query = ctx.url.searchParams;
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state);
      pulls.sort((a, b) => b.number - a.number);
      sendJson(ctx, 200, pulls.map((p) => pullJson(repo, p)));
      return;
    }
    if (method === 'POST') {
      const title = str(body!.title ?? '');
      const head = str(body!.head ?? '');
      const base = str(body!.base ?? '');
      if (title === '' || head === '' || base === '') {
        sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }] });
        return;
      }
      const headSha = repo.branchSha(head);
      const baseSha = repo.branchSha(base);
      if (headSha === undefined) { sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] }); return; }
      if (baseSha === undefined) { sendError(ctx, 422, 'Validation Failed', { errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] }); return; }
      const t = store.nowIso();
      const pull: Pull = {
        number: ++repo.issueSeq,
        title,
        body: str(body!.body ?? ''),
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        mergeable: true,
        files: store.diffTrees(repo, baseSha, headSha),
        user: VIEWER,
        createdAt: t,
        updatedAt: t,
        closedAt: null,
      };
      repo.pulls.set(pull.number, pull);
      sendJson(ctx, 201, pullJson(repo, pull));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const n = Number(parts[0]);
  const pull = Number.isInteger(n) ? repo.pulls.get(n) : undefined;
  if (!pull) { sendError(ctx, 404, 'Not Found'); return; }

  if (parts.length === 1 && method === 'GET') { sendJson(ctx, 200, pullJson(repo, pull)); return; }

  if (parts[1] === 'files' && parts.length === 2 && method === 'GET') {
    sendJson(ctx, 200, pull.files.map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: `${repo.owner}/${repo.name}/blob/${pull.headRef}/${f.filename}`,
      raw_url: `/${repo.owner}/${repo.name}/raw/${pull.headRef}/${f.filename}`,
      contents_url: `${ownerUrl(repo.owner, repo.name)}/contents/${f.filename}?ref=${pull.headRef}`,
      patch: null,
    })));
    return;
  }

  if (parts[1] === 'merge' && parts.length === 2 && method === 'PUT') {
    if (pull.state === 'closed' && pull.merged) { sendError(ctx, 405, 'Pull Request is not mergeable'); return; }
    const result = store.mergePull(repo, pull, str(body!.commit_title ?? '') || pull.title || `Merge pull request #${pull.number}`);
    if (result === 'conflict') {
      sendError(ctx, 405, 'Pull Request is not mergeable');
      return;
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = result;
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = pull.mergedAt;
    sendJson(ctx, 200, { merged: true, sha: result, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}
