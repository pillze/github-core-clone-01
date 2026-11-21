// GraphQL v4 API at /api/graphql — the documents gh and github-mcp-server send.
import { store, Repo, VIEWER, Issue, Pull } from './store.ts';
import { Ctx, sendJson, sendError } from './rest.ts';
import { buildCommit, parseCommit } from './gitobj.ts';

interface GqlError { message: string; type?: string; path?: string[]; locations?: { line: number; column: number }[]; }

function b64id(text: string): string { return Buffer.from(text, 'utf8').toString('base64'); }
function unb64id(id: string): string { try { return Buffer.from(id, 'base64').toString('utf8'); } catch { return ''; } }

const repoGid = (owner: string, name: string): string => b64id(`Repository:${owner}/${name}`);
const issueGid = (owner: string, name: string, n: number): string => b64id(`Issue:${owner}/${name}/${n}`);
const pullGid = (owner: string, name: string, n: number): string => b64id(`PullRequest:${owner}/${name}/${n}`);
const userGid = (login: string): string => b64id(`User:${login}`);
const commentGid = (owner: string, name: string, n: number, cid: number): string => b64id(`IssueComment:${owner}/${name}/${n}/${cid}`);

const ISSUE_FIELD_NAMES = [
  'id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels',
  'comments', 'repository', 'url', 'activeLockReason', 'assignees', 'bodyText', 'bodyHTML',
];
const PULL_FIELD_NAMES = [
  'id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'merged',
  'mergedAt', 'mergeable', 'mergeCommit', 'files', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid',
  'comments', 'commits', 'repository', 'url', 'additions', 'deletions', 'changedFiles', 'reviewDecision',
];
const REPO_FIELD_NAMES = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'hasWikiEnabled', 'issues', 'pullRequests', 'createdAt', 'updatedAt', 'pushedAt',
  'isPrivate', 'visibility', 'url', 'sshUrl', 'isEmpty', 'diskUsage', 'licenseInfo', 'primaryLanguage',
];
const SEARCH_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION', 'PULL_REQUEST', 'APP'];

// ---------------------------------------------------------------- tiny GraphQL parser

type Sel = { kind: 'field'; name: string; alias?: string; args: Record<string, unknown>; sels: Sel[] }
  | { kind: 'inline'; type?: string; sels: Sel[] };

function parseDoc(doc: string): { op: 'query' | 'mutation'; sels: Sel[] } {
  const tokens = tokenize(doc);
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const eat = (): string => tokens[i++]!;
  let op: 'query' | 'mutation' = 'query';
  // skip operation name and variable definitions
  while (i < tokens.length && tokens[i] !== '{') {
    if (tokens[i] === 'query') op = 'query';
    if (tokens[i] === 'mutation') op = 'mutation';
    i++;
  }
  const sels = parseSelectionSet();
  return { op, sels };

  function tokenize(src: string): string[] {
    const out: string[] = [];
    let k = 0;
    while (k < src.length) {
      const c = src[k]!;
      if (/\s/.test(c)) { k++; continue; }
      if (c === ',' || c === '(' || c === ')' || c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === '$' || c === '!' || c === '.') {
        // gather ellipsis
        if (c === '.' && src.slice(k, k + 3) === '...') { out.push('...'); k += 3; continue; }
        out.push(c); k++; continue;
      }
      if (c === '"') {
        const end = src.indexOf('"', k + 1);
        out.push(src.slice(k, end < 0 ? src.length : end + 1));
        k = end < 0 ? src.length : end + 1;
        continue;
      }
      let j = k;
      while (j < src.length && !/[\s,(){}[\]:$!"]/.test(src[j]!) && !(src[j] === '.' && src.slice(j, j + 3) === '...')) j++;
      out.push(src.slice(k, j));
      k = j;
    }
    return out;
  }

  function parseSelectionSet(): Sel[] {
    const out: Sel[] = [];
    if (peek() !== '{') return out;
    eat(); // {
    while (i < tokens.length && peek() !== '}') {
      if (peek() === '...') {
        eat();
        let type: string | undefined;
        if (peek() === 'on') { eat(); type = eat(); }
        out.push({ kind: 'inline', type, sels: parseSelectionSet() });
        continue;
      }
      let first = eat();
      let alias: string | undefined;
      if (peek() === ':') { eat(); alias = first; first = eat(); }
      const args: Record<string, unknown> = {};
      if (peek() === '(') {
        eat();
        while (peek() !== ')' && i < tokens.length) {
          let an = eat();
          if (an === ':') an = eat();
          if (peek() === ':') eat();
          args[an] = parseValue();
        }
        if (peek() === ')') eat();
      }
      let sels: Sel[] = [];
      if (peek() === '{') sels = parseSelectionSet();
      // skip directives like @include(if:) @skip
      while (peek() === '@') { eat(); if (peek() === '(') { eat(); let depth = 1; while (depth > 0 && i < tokens.length) { const t = eat(); if (t === '(') depth++; if (t === ')') depth--; } } }
      out.push({ kind: 'field', name: first, alias, args, sels });
    }
    if (peek() === '}') eat();
    return out;
  }

  function parseValue(): unknown {
    const t = peek();
    if (t === undefined) return null;
    if (t === '$') { eat(); return variables.get(eat()) ?? null; }
    if (t === '[') {
      eat();
      const arr: unknown[] = [];
      while (peek() !== ']' && i < tokens.length) arr.push(parseValue());
      if (peek() === ']') eat();
      return arr;
    }
    if (t === '{') {
      eat();
      const obj: Record<string, unknown> = {};
      while (peek() !== '}' && i < tokens.length) {
        let key = eat();
        if (key === ':') key = eat();
        if (peek() === ':') eat();
        obj[key] = parseValue();
      }
      if (peek() === '}') eat();
      return obj;
    }
    eat();
    if (t.startsWith('"')) return t.slice(1, -1);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t; // bare enum token
  }
}

const variables = new Map<string, unknown>();

// ---------------------------------------------------------------- resolvers

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGid(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    databaseId: issue.number,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullGid(repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.merged ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    databaseId: pull.number,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    files: { nodes: pull.files.map((f) => ({ path: f.filename })), pageInfo: { hasNextPage: false, endCursor: null } },
  };
}

function resolveField(obj: Record<string, unknown>, sel: Sel, ctx: { repo?: Repo }): unknown {
  if (sel.kind === 'inline') {
    return resolveObject(obj, sel.sels, ctx);
  }
  const name = sel.name;
  if (name.startsWith('__')) return schemaField(sel);
  const value = obj[name];
  if (value && typeof value === 'object' && sel.sels.length > 0) {
    if (Array.isArray(value)) return value.map((v) => resolveObject(v as Record<string, unknown>, sel.sels, ctx));
    return resolveObject(value as Record<string, unknown>, sel.sels, ctx);
  }
  return value ?? null;
}

function resolveObject(obj: Record<string, unknown>, sels: Sel[], ctx: { repo?: Repo }): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'inline') {
      if (sel.type && sel.type !== 'Repository' && !('nameWithOwner' in obj)) continue;
      Object.assign(out, resolveObject(obj, sel.sels, ctx) ?? {});
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = resolveField(obj, sel, ctx);
  }
  return out;
}

function schemaField(sel: Sel): unknown {
  if (sel.name === '__typename') return 'Query';
  const name = (sel.args['name'] as string) ?? '';
  const fieldSels = (sel.sels.find((s) => s.kind === 'field' && s.name === 'fields') ?? null);
  const enumSels = (sel.sels.find((s) => s.kind === 'field' && s.name === 'enumValues') ?? null);
  const names: Record<string, string[]> = {
    Issue: ISSUE_FIELD_NAMES, PullRequest: PULL_FIELD_NAMES, Repository: REPO_FIELD_NAMES,
  };
  if (fieldSels && fieldSels.kind === 'field') {
    return { name, fields: (names[name] ?? []).map((n) => ({ name: n })) };
  }
  if (enumSels && enumSels.kind === 'field') {
    return { name, enumValues: SEARCH_ENUMS.map((n) => ({ name: n })) };
  }
  return { name, fields: null, enumValues: null };
}

function repoRefOf(id: string): { repo: Repo; owner: string; name: string } | null {
  const repo = store.getRepo(id[0]!, id[1]!);
  return repo ? { repo, owner: id[0]!, name: id[1]! } : null;
}

function repoObject(repo: Repo): Record<string, unknown> {
  const defaultBranch = repo.defaultBranch;
  const headSha = repo.branchSha(defaultBranch);
  return {
    id: repoGid(repo.owner, repo.name),
    databaseId: 5000,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: userGid(repo.owner) },
    description: repo.description,
    isPrivate: repo.isPrivate,
    visibility: repo.isPrivate ? 'PRIVATE' : 'PUBLIC',
    defaultBranchRef: { name: defaultBranch, id: b64id(`Ref:${repo.owner}/${repo.name}/${defaultBranch}`) },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasWikiEnabled: false,
    isEmpty: headSha === undefined,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
    issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
}

interface GqlOutcome { data?: Record<string, unknown> | null; errors?: GqlError[]; }

function runOperation(doc: string, vars: Record<string, unknown>): GqlOutcome {
  variables.clear();
  for (const [k, v] of Object.entries(vars ?? {})) variables.set(k, v);
  let parsed;
  try { parsed = parseDoc(doc); } catch (err) {
    return { errors: [{ message: `The query failed to parse: ${err instanceof Error ? err.message : 'parse error'}` }] };
  }
  const errors: GqlError[] = [];
  const data: Record<string, unknown> = {};
  for (const sel of parsed.sels) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    data[key] = topLevel(sel, parsed.op, errors);
  }
  return errors.length ? { data, errors } : { data };
}

function topLevel(sel: Sel & { kind: 'field' }, op: 'query' | 'mutation', errors: GqlError[]): unknown {
  const name = sel.name;
  const args = sel.args;

  if (name === 'viewer') {
    const obj: Record<string, unknown> = { login: VIEWER.login, id: userGid(VIEWER.login), name: VIEWER.name, __typename: 'User' };
    const unknown = sel.sels.find((s) => s.kind === 'field' && !(s.name in obj) && !s.name.startsWith('__'));
    if (unknown) {
      errors.push({ message: `The \`Viewer\` type has no field \`${unknown.name}\`. Did you mean \`${['login', 'name', 'id'].join('`, `')}\`?`, path: ['viewer'] });
      return null;
    }
    return resolveObject(obj, sel.sels, {});
  }

  if (name === '__type') return schemaField(sel);
  if (name === '__schema') {
    return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
  }

  if (name === 'node') {
    const id = String(args['id'] ?? '');
    const decoded = unb64id(id);
    if (decoded.startsWith('Repository:')) {
      const rest = decoded.slice('Repository:'.length);
      const slash = rest.indexOf('/');
      const ref = repoRefOf([rest.slice(0, slash), rest.slice(slash + 1)]);
      if (!ref) { errors.push({ message: `Could not resolve to a node with the global id of '${id}'`, type: 'NOT_FOUND' }); return null; }
      const obj = { ...repoObject(ref.repo), nameWithOwner: `${ref.owner}/${ref.name}` };
      return resolveObject(obj, sel.sels, { repo: ref.repo });
    }
    errors.push({ message: `Could not resolve to a node with the global id of '${id}'`, type: 'NOT_FOUND' });
    return null;
  }

  if (name === 'repository') {
    const owner = String(args['owner'] ?? '');
    const rname = String(args['name'] ?? '');
    const ref = repoRefOf([owner, rname]);
    if (!ref) {
      errors.push({ message: `Could not resolve to a Repository with the name '${owner}/${rname}'.`, type: 'NOT_FOUND', path: [key] });
      return null;
    }
    return repositorySelection(ref.repo, sel.sels, errors);
  }

  if (op === 'mutation') return mutationTop(sel, errors);

  errors.push({ message: `The \`Query\` type has no field \`${name}\`.` });
  return null;
}

function repositorySelection(repo: Repo, sels: Sel[], errors: GqlError[]): unknown {
  const obj = repoObject(repo);
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'inline') { Object.assign(out, repositorySelection(repo, sel.sels, errors) ?? {}); continue; }
    const key = sel.alias ?? sel.name;
    if (sel.name === 'issues') {
      out[key] = issuesConnection(repo, sel.args, sel.sels);
      continue;
    }
    if (sel.name === 'pullRequests') {
      out[key] = pullsConnection(repo, sel.args, sel.sels);
      continue;
    }
    if (sel.name === 'issue') {
      const n = Number(sel.args['number']);
      const issue = repo.issues.get(n);
      if (!issue) {
        errors.push({ message: `Could not resolve to an Issue with the number of ${sel.args['number']}.`, type: 'NOT_FOUND', path: [key] });
        out[key] = null;
        continue;
      }
      out[key] = resolveObject(issueNode(repo, issue), sel.sels, { repo });
      continue;
    }
    if (sel.name === 'pullRequest') {
      const n = Number(sel.args['number']);
      const pull = repo.pulls.get(n);
      if (!pull) {
        errors.push({ message: `Could not resolve to a PullRequest with the number of ${sel.args['number']}.`, type: 'NOT_FOUND', path: [key] });
        out[key] = null;
        continue;
      }
      out[key] = resolveObject(pullNode(repo, pull), sel.sels, { repo });
      continue;
    }
    if (sel.name === 'defaultBranchRef') {
      out[key] = resolveObject(obj['defaultBranchRef'] as Record<string, unknown>, sel.sels, {});
      continue;
    }
    if (sel.name === 'owner') {
      out[key] = resolveObject(obj['owner'] as Record<string, unknown>, sel.sels, {});
      continue;
    }
    if (sel.name in obj) {
      const v = obj[sel.name];
      out[key] = v && typeof v === 'object' && sel.sels.length ? resolveObject(v as Record<string, unknown>, sel.sels, {}) : (v ?? null);
      continue;
    }
    errors.push({ message: `The \`Repository\` type has no field \`${sel.name}\`.`, path: [key] });
    out[key] = null;
  }
  return out;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>, sels: Sel[]): unknown {
  const first = Number(args['first'] ?? 10);
  const after = args['after'] === null || args['after'] === undefined ? null : String(args['after']);
  const states = Array.isArray(args['states']) ? args['states'] as string[] : null;
  const orderBy = args['orderBy'] as Record<string, unknown> | undefined;
  let issues = [...repo.issues.values()];
  if (states && states.length) issues = issues.filter((i) => states.some((s) => s.toLowerCase() === i.state));
  if (orderBy && String(orderBy['field'] ?? '').toUpperCase() === 'CREATED_AT') {
    const dir = String(orderBy['direction'] ?? 'ASC').toUpperCase();
    issues.sort((a, b) => dir === 'DESC' ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt));
  }
  let startIdx = 0;
  if (after) {
    const decoded = unb64id(after);
    const n = Number(decoded.replace(/^cursor:/, ''));
    startIdx = issues.findIndex((i) => i.number === n);
    startIdx = startIdx < 0 ? 0 : startIdx + 1;
  }
  const page = issues.slice(startIdx, startIdx + (Number.isFinite(first) && first > 0 ? first : 10));
  const hasNextPage = startIdx + page.length < issues.length;
  const endCursor = page.length ? b64id(`cursor:${page[page.length - 1]!.number}`) : null;
  const conn: Record<string, unknown> = { pageInfo: { hasNextPage, endCursor }, totalCount: issues.length };
  for (const sel of sels) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'nodes') {
      conn[key] = page.map((i) => resolveObject(issueNode(repo, i), sel.sels, { repo }));
    } else if (sel.name === 'edges') {
      conn[key] = page.map((i) => ({ node: resolveObject(issueNode(repo, i), sel.sels, { repo }), cursor: b64id(`cursor:${i.number}`) }));
    } else if (sel.name === 'pageInfo') {
      conn[key] = resolveObject(conn['pageInfo'] as Record<string, unknown>, sel.sels, {});
    } else if (sel.name === 'totalCount') {
      conn[key] = issues.length;
    } else {
      conn[key] = null;
    }
  }
  return conn;
}

function pullsConnection(repo: Repo, args: Record<string, unknown>, sels: Sel[]): unknown {
  const first = Number(args['first'] ?? 10);
  const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, Number.isFinite(first) && first > 0 ? first : 10);
  const conn: Record<string, unknown> = { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: repo.pulls.size };
  for (const sel of sels) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'nodes') conn[key] = pulls.map((p) => resolveObject(pullNode(repo, p), sel.sels, { repo }));
    else if (sel.name === 'pageInfo') conn[key] = resolveObject(conn['pageInfo'] as Record<string, unknown>, sel.sels, {});
    else if (sel.name === 'totalCount') conn[key] = repo.pulls.size;
    else conn[key] = null;
  }
  return conn;
}

function findByGid(id: string): { repo: Repo; kind: 'Issue' | 'PullRequest'; n: number } | null {
  const decoded = unb64id(id);
  const m = /^(Issue|PullRequest):([^/]+)\/([^/]+)\/(\d+)$/.exec(decoded);
  if (!m) return null;
  const ref = repoRefOf([m[2]!, m[3]!]);
  if (!ref) return null;
  return { repo: ref.repo, kind: m[1] as 'Issue' | 'PullRequest', n: Number(m[4]) };
}

function mutationTop(sel: Sel & { kind: 'field' }, errors: GqlError[]): unknown {
  const input = (sel.args['input'] ?? {}) as Record<string, unknown>;
  const key = sel.alias ?? sel.name;

  if (sel.name === 'createIssue') {
    let repo: Repo | null = null;
    if (typeof input['repositoryId'] === 'string') {
      const decoded = unb64id(input['repositoryId']);
      if (decoded.startsWith('Repository:')) {
        const rest = decoded.slice('Repository:'.length).split('/');
        repo = store.getRepo(rest[0]!, rest[1]!) ?? null;
      }
    } else if (typeof input['repositoryName'] === 'string') {
      repo = store.getRepo(String(input['repositoryOwner'] ?? VIEWER.login), String(input['repositoryName'])) ?? null;
    }
    if (!repo) { errors.push({ message: `Could not resolve to a node with the global id of '${String(input['repositoryId'] ?? '')}'`, type: 'NOT_FOUND' }); return null; }
    const title = String(input['title'] ?? '');
    const t = store.nowIso();
    const issue: Issue = { number: ++repo.issueSeq, title, body: String(input['body'] ?? ''), state: 'open', labels: [], user: VIEWER, createdAt: t, updatedAt: t, closedAt: null, comments: [], commentSeq: 0 };
    repo.issues.set(issue.number, issue);
    return resolveObject({ createIssue: { issue: issueNode(repo, issue) } }, [{ kind: 'field', name: 'createIssue', alias: key, args: {}, sels: sel.sels }], { repo });
  }

  if (sel.name === 'closeIssue') {
    let repo: Repo | null = null; let n: number | null = null;
    if (typeof input['issueId'] === 'string') {
      const found = findByGid(input['issueId']);
      if (found && found.kind === 'Issue') { repo = found.repo; n = found.n; }
    }
    if (!repo || n === null || !repo.issues.get(n)) {
      errors.push({ message: `Could not resolve to a node with the global id of '${String(input['issueId'] ?? input['repositoryId'] ?? '')}'`, type: 'NOT_FOUND' });
      return null;
    }
    const issue = repo.issues.get(n)!;
    issue.state = 'closed';
    issue.closedAt = store.nowIso();
    issue.updatedAt = issue.closedAt;
    return resolveObject({ closeIssue: { issue: issueNode(repo, issue) } }, [{ kind: 'field', name: 'closeIssue', alias: key, args: {}, sels: sel.sels }], { repo });
  }

  if (sel.name === 'addComment') {
    let repo: Repo | null = null; let n: number | null = null;
    if (typeof input['subjectId'] === 'string') {
      const found = findByGid(input['subjectId']);
      if (found) { repo = found.repo; n = found.n; }
    }
    if (!repo || n === null) { errors.push({ message: `Could not resolve to a node with the global id of '${String(input['subjectId'] ?? '')}'`, type: 'NOT_FOUND' }); return null; }
    const issue = repo.issues.get(n);
    const pull = issue ? undefined : repo.pulls.get(n);
    const target = issue ?? pull;
    if (!target) { errors.push({ message: 'Subject not found', type: 'NOT_FOUND' }); return null; }
    const body = String(input['body'] ?? '');
    const cid = ++repo.commentIdSeq;
    const t = store.nowIso();
    const node = { id: commentGid(repo.owner, repo.name, n, cid), body, databaseId: cid };
    if (issue) {
      issue.comments.push({ id: cid, body, user: VIEWER, createdAt: t, updatedAt: t });
    }
    return resolveObject({ addComment: { commentEdge: { node } } }, [{ kind: 'field', name: 'addComment', alias: key, args: {}, sels: sel.sels }], { repo });
  }

  if (sel.name === 'createPullRequest') {
    let repo: Repo | null = null;
    if (typeof input['repositoryId'] === 'string') {
      const decoded = unb64id(input['repositoryId']);
      if (decoded.startsWith('Repository:')) {
        const rest = decoded.slice('Repository:'.length).split('/');
        repo = store.getRepo(rest[0]!, rest[1]!) ?? null;
      }
    }
    if (!repo) { errors.push({ message: `Could not resolve to a node with the global id of '${String(input['repositoryId'] ?? '')}'`, type: 'NOT_FOUND' }); return null; }
    const head = String(input['headRefName'] ?? '');
    const base = String(input['baseRefName'] ?? 'main');
    const headSha = repo.branchSha(head);
    const baseSha = repo.branchSha(base);
    if (headSha === undefined) { errors.push({ message: `Head ref '${head}' cannot be resolved to a commit`, type: 'UNPROCESSABLE' }); return null; }
    const t = store.nowIso();
    const pull: Pull = {
      number: ++repo.issueSeq, title: String(input['title'] ?? ''), body: String(input['body'] ?? ''), state: 'open',
      headRef: head, baseRef: base, headSha, baseSha: baseSha ?? headSha, merged: false, mergedAt: null,
      mergeCommitSha: null, mergeable: true, files: store.diffTrees(repo, baseSha ?? headSha, headSha),
      user: VIEWER, createdAt: t, updatedAt: t, closedAt: null,
    };
    repo.pulls.set(pull.number, pull);
    return resolveObject({ createPullRequest: { pullRequest: pullNode(repo, pull) } }, [{ kind: 'field', name: 'createPullRequest', alias: key, args: {}, sels: sel.sels }], { repo });
  }

  if (sel.name === 'mergePullRequest') {
    let repo: Repo | null = null; let n: number | null = null;
    if (typeof input['pullRequestId'] === 'string') {
      const found = findByGid(input['pullRequestId']);
      if (found && found.kind === 'PullRequest') { repo = found.repo; n = found.n; }
    }
    if (!repo || n === null || !repo.pulls.get(n)) {
      errors.push({ message: `Could not resolve to a node with the global id of '${String(input['pullRequestId'] ?? '')}'`, type: 'NOT_FOUND' });
      return null;
    }
    const pull = repo.pulls.get(n)!;
    const result = store.mergePull(repo, pull, pull.title || `Merge pull request #${pull.number}`);
    if (result === 'conflict') {
      errors.push({ message: 'Pull Request is not mergeable', type: 'CONFLICT' });
      return null;
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = result;
    pull.closedAt = pull.mergedAt;
    return resolveObject({ mergePullRequest: { pullRequest: pullNode(repo, pull) } }, [{ kind: 'field', name: 'mergePullRequest', alias: key, args: {}, sels: sel.sels }], { repo });
  }

  errors.push({ message: `The \`Mutation\` type has no field \`${sel.name}\`.` });
  return null;
}

// ---------------------------------------------------------------- HTTP entry

export function handleGraphQL(ctx: Ctx, authenticated: boolean): void {
  if (!authenticated) { sendError(ctx, 401, 'This endpoint requires you to be authenticated.'); return; }
  let body: unknown;
  try { body = JSON.parse(ctx.body.toString('utf8') || '{}'); } catch {
    sendJson(ctx, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => oneQuery(entry as Record<string, unknown>));
    sendJson(ctx, 200, results);
    return;
  }
  const result = oneQuery((body ?? {}) as Record<string, unknown>);
  sendJson(ctx, 200, result);
}

function oneQuery(entry: Record<string, unknown>): GqlOutcome {
  const query = typeof entry['query'] === 'string' ? entry['query'] : '';
  if (query === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  const vars = (entry['variables'] ?? {}) as Record<string, unknown>;
  return runOperation(query, vars ?? {});
}
