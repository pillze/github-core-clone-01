// In-memory domain store: users, repositories, issues, labels, comments, pull requests.
// Deterministic ids and timestamps; no Date.now / Math.random in served data.
import { GitObject, buildTree, buildCommit, buildTag, shaOfObject, parseCommit, parseTree, ObjType, TreeSpec } from './gitobj.ts';

export interface User { id: number; login: string; name: string; email: string; }

export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const USERS = new Map<string, User>([[VIEWER.login, VIEWER], [STRANGER.login, STRANGER]]);

export interface Label { name: string; color: string; description: string | null; }

export interface IssueComment { id: number; body: string; user: User; createdAt: string; updatedAt: string; }

export interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; user: User; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: IssueComment[]; commentSeq: number;
}

export interface PullFile { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number; sha: string; }

export interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; mergeable: boolean;
  files: PullFile[]; user: User; createdAt: string; updatedAt: string; closedAt: string | null;
}

export class Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  createdAt: string;
  updatedAt: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // full refname -> oid
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  issueSeq = 0;
  pulls = new Map<number, Pull>();
  pullSeq = 0;
  commentIdSeq = 1000;

  constructor(name: string, owner: string, description: string, isPrivate: boolean) {
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    const t = nowIso();
    this.createdAt = t;
    this.updatedAt = t;
  }

  refSha(ref: string): string | undefined { return this.refs.get(ref); }
  branchSha(branch: string): string | undefined { return this.refs.get(`refs/heads/${branch}`); }
  setBranch(branch: string, sha: string): void { this.refs.set(`refs/heads/${branch}`, sha); }
  deleteBranch(branch: string): void { this.refs.delete(`refs/heads/${branch}`); }

  putObject(obj: GitObject, sha?: string): string {
    const oid = sha ?? shaOfObject(obj.type, obj.data);
    this.objects.set(oid, obj);
    return oid;
  }

  /** Walk commits from a tip, newest first. */
  walkCommits(tip: string): { sha: string; commit: ReturnType<typeof parseCommit> }[] {
    const out: { sha: string; commit: ReturnType<typeof parseCommit> }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      out.push({ sha, commit });
      for (const p of commit.parents) stack.push(p);
    }
    out.sort((a, b) => b.commit.ts - a.commit.ts);
    return out;
  }

  /** Recursive tree listing of a tip's tree. */
  listTree(tip: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const visit = (treeOid: string, prefix: string): void => {
      const obj = this.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') visit(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    const commit = this.objects.get(tip);
    if (!commit || commit.type !== 'commit') return out;
    const c = parseCommit(commit.data);
    visit(c.tree, '');
    return out;
  }
}

export class Store {
  repos = new Map<string, Repo>(); // key owner/name
  nowCounter = 0;
  baseMs: number;

  constructor() {
    const env = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = env ? Date.parse(env) : NaN;
    this.baseMs = Number.isFinite(parsed) ? parsed : Date.parse('2026-11-21T00:00:00Z');
  }

  /** Deterministic clock: every call advances one second past the trial's start. */
  nowIso(): string {
    this.nowCounter += 1;
    return new Date(this.baseMs + this.nowCounter * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  nowUnix(): number {
    return Math.floor((this.baseMs + (this.nowCounter + 1) * 1000) / 1000);
  }

  key(owner: string, name: string): string { return `${owner}/${name}`; }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login);
  }

  createRepo(name: string, isPrivate: boolean, description: string, owner: string = VIEWER.login): Repo {
    const repo = new Repo(name, owner, description, isPrivate);
    repo.defaultBranch = 'main';
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  /** Diff two tree listings into pull files. */
  diffTrees(repo: Repo, baseTip: string, headTip: string): PullFile[] {
    const base = repo.listTree(baseTip);
    const head = repo.listTree(headTip);
    const files: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      const baseLines = b ? splitLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0)) : [];
      const headLines = h ? splitLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0)) : [];
      const baseSet = new Map<string, number>();
      for (const l of baseLines) baseSet.set(l, (baseSet.get(l) ?? 0) + 1);
      const headSet = new Map<string, number>();
      for (const l of headLines) headSet.set(l, (headSet.get(l) ?? 0) + 1);
      let additions = 0, deletions = 0;
      for (const [l, n] of headSet) { const d = n - (baseSet.get(l) ?? 0); if (d > 0) additions += d; }
      for (const [l, n] of baseSet) { const d = n - (headSet.get(l) ?? 0); if (d > 0) deletions += d; }
      const status: PullFile['status'] = !b && h ? 'added' : b && !h ? 'removed' : 'modified';
      const data = h ? repo.objects.get(h.oid)?.data ?? Buffer.alloc(0) : repo.objects.get(b!.oid)?.data ?? Buffer.alloc(0);
      files.push({ filename: path, status, additions, deletions, changes: additions + deletions, sha: (h ?? b)!.oid });
      void data;
    }
    return files;
  }

  /** Squash-merge a pull onto its base branch. Returns merge commit sha or 'conflict'. */
  mergePull(repo: Repo, pull: Pull, message: string): string | 'conflict' {
    const baseTip = repo.branchSha(pull.baseRef);
    if (baseTip === undefined) return 'conflict';
    if (baseTip !== pull.baseSha) {
      // base moved since creation: conflict when changed paths intersect
      const moved = this.diffTrees(repo, pull.baseSha, baseTip).map((f) => f.filename);
      const touch = new Set(pull.files.map((f) => f.filename));
      if (moved.some((p) => touch.has(p))) return 'conflict';
    }
    const headObj = repo.objects.get(pull.headSha);
    if (!headObj) return 'conflict';
    const headCommit = parseCommit(headObj.data);
    const { oid: treeOid } = buildTree(this.treeSpecsFromListing(repo.listTree(pull.headSha)));
    const ts = this.nowUnix();
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      ts,
    });
    repo.putObject({ type: 'commit', data: commit.data }, commit.oid);
    repo.setBranch(pull.baseRef, commit.oid);
    return commit.oid;
  }

  treeSpecsFromListing(listing: Map<string, { oid: string; mode: string }>): TreeSpec[] {
    const specs: TreeSpec[] = [];
    for (const [path, entry] of listing) specs.push({ path, oid: entry.oid, mode: entry.mode });
    return specs;
  }
}

function splitLines(data: Buffer): string[] {
  return data.toString('utf8').split('\n');
}

// global store instance
export const store = new Store();

// deterministic clock shared with gitobj consumers
let sharedStore = store;
export function nowIso(): string { return sharedStore.nowIso(); }
export function nowUnix(): number { return sharedStore.nowUnix(); }