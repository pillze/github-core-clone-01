// Git smart HTTP: info/refs (v2 upload-pack + v0 receive-pack), ls-refs, fetch (full/shallow),
// packfile serving with delta reuse, receive-pack push with report-status.
import { IncomingMessage, ServerResponse } from 'node:http';
import { store, Repo, VIEWER } from './store.ts';
import { Ctx, sendError, sendJson } from './rest.ts';
import {
  GitObject, ObjType, Pkt, readPkts, pktLine, flushPkt, sidebandBand,
  readPack, buildPackExact, parseCommit, parseTree, shaOfObject,
} from './gitobj.ts';

const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'agent=entry-forge/1.0';

function gitRepo(owner: string, nameWithGit: string): Repo | null {
  const name = nameWithGit.endsWith('.git') ? nameWithGit.slice(0, -4) : nameWithGit;
  return store.getRepo(owner, name);
}

function bytes(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-cache',
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function refEntries(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name === 'refs/heads/main' ? -1 : b.name === 'refs/heads/main' ? 1 : a.name.localeCompare(b.name)));
}

function peeledOid(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i++) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (!m) return null;
      current = m[1]!;
      continue;
    }
    return obj.type === 'commit' ? current : null;
  }
  return null;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(ctx: Ctx, owner: string, repoNameGit: string, service: string): void {
  const repo = gitRepo(owner, repoNameGit);
  if (!repo || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const proto = ctx.req.headers['git-protocol'];
  const wantsV2 = service === 'git-upload-pack' && typeof proto === 'string' && proto.includes('version=2');
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  if (wantsV2) {
    chunks.push(pktLine('version 2\n'));
    chunks.push(pktLine('agent=entry-forge/1.0\n'));
    chunks.push(pktLine('ls-refs=unborn\n'));
    chunks.push(pktLine('fetch=shallow\n'));
    chunks.push(pktLine('object-format=sha1\n'));
    chunks.push(flushPkt());
    bytes(ctx.res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(chunks), ctx.requestId);
    return;
  }
  // v0 advertisement
  const refs = refEntries(repo);
  const caps = service === 'git-receive-pack'
    ? ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', AGENT, ...(repo.defaultBranch ? [`symref=HEAD:refs/heads/${repo.defaultBranch}`] : [])]
    : ['multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'agent=entry-forge/1.0', 'allow-tip-sha1-in-want', ...(repo.defaultBranch ? [`symref=HEAD:refs/heads/${repo.defaultBranch}`] : [])];
  const capText = `\0${caps.join(' ')}\n`;
  if (refs.length === 0) {
    // unborn: advertise the capabilities pseudo-ref
    chunks.push(pktLine(`${ZERO} capabilities^{}${capText}`));
  } else {
    let first = true;
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}${capText}` : `${ref.oid} ${ref.name}\n`;
      chunks.push(pktLine(line));
      first = false;
      const peeled = peeledOid(repo, ref.oid);
      if (peeled && peeled !== ref.oid && ref.name.startsWith('refs/tags/')) {
        chunks.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  chunks.push(flushPkt());
  bytes(ctx.res, 200, `application/x-${service}-advertisement`, Buffer.concat(chunks), ctx.requestId);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(ctx: Ctx, owner: string, repoNameGit: string): void {
  const repo = gitRepo(owner, repoNameGit);
  if (!repo) { sendError(ctx, 404, 'Not Found'); return; }
  let body = ctx.body;
  const { pkts } = readPkts(body);
  const lines = pkts.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  if (lines.length === 0 || !/^command=/.test(lines[0] ?? '')) {
    // malformed request: respond error but keep server healthy
    bytes(ctx.res, 400, 'application/x-git-upload-pack-result', pktLine('ERR bad request\n'), ctx.requestId);
    return;
  }
  const command = lines[0]!.trim().slice('command='.length);
  const delimIndex = lines.findIndex((l) => l === '' && pkts[lines.indexOf(l)]?.kind === 'delim');
  void delimIndex;
  let argsStart = 1;
  for (let i = 1; i < pkts.length; i++) {
    if (pkts[i]!.kind === 'delim' || pkts[i]!.kind === 'flush') { argsStart = i + 1; break; }
  }
  const argLines: string[] = [];
  for (let i = argsStart; i < pkts.length; i++) {
    const p = pkts[i]!;
    if (p.kind === 'flush') break;
    if (p.kind === 'data') argLines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }

  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false, symrefs = false, unborn = false;
    for (const a of argLines) {
      if (a === 'peel') peel = true;
      else if (a === 'symrefs') symrefs = true;
      else if (a === 'unborn') unborn = true;
      else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    const headTarget = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const lineFor = (name: string, oid: string): Buffer => {
      let text = `${oid} ${name}`;
      if (symrefs && name === 'HEAD') text += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (peel && name.startsWith('refs/tags/')) {
        const peeled = peeledOid(repo, oid);
        if (peeled && peeled !== oid) text += ` peeled:${peeled}`;
      }
      return pktLine(`${text}\n`);
    };
    if (!repo.defaultBranch || headTarget === undefined) {
      if (unborn && matches('HEAD')) out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (matches('HEAD')) {
      out.push(lineFor('HEAD', headTarget));
    }
    for (const ref of refEntries(repo)) {
      if (!matches(ref.name)) continue;
      out.push(lineFor(ref.name, ref.oid));
    }
    out.push(flushPkt());
    bytes(ctx.res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out), ctx.requestId);
    return;
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | null = null;
    let done = false;
    let noProgress = false;
    for (const a of argLines) {
      if (a.startsWith('want ')) wants.push(a.slice(5).trim().toLowerCase());
      else if (a.startsWith('have ')) haves.push(a.slice(5).trim().toLowerCase());
      else if (a.startsWith('shallow ')) shallowIn.push(a.slice(8).trim().toLowerCase());
      else if (a.startsWith('deepen ')) depth = Number(a.slice(7).trim());
      else if (a === 'done') done = true;
      else if (a === 'no-progress') noProgress = true;
    }
    const out: Buffer[] = [];
    const shallowOut: string[] = [];
    const unshallowOut: string[] = [];
    let sendObjects: string[] = [];

    if (done) {
      const haveSet = new Set(haves);
      const shallowSet = new Set(shallowIn);
      // commits to send, with generation cutoff for shallow
      const gen = new Map<string, number>();
      const order: string[] = [];
      const queue: { oid: string; g: number }[] = wants.map((w) => ({ oid: w, g: 1 }));
      const maxGen = depth === null || !Number.isFinite(depth) ? Infinity : Math.max(Math.floor(depth), 1);
      while (queue.length) {
        const { oid, g } = queue.shift()!;
        if (gen.has(oid) && gen.get(oid)! <= g) continue;
        if (g > maxGen) continue;
        if (!repo.objects.has(oid)) continue;
        gen.set(oid, Math.min(gen.get(oid) ?? Infinity, g));
        order.push(oid);
        const obj = repo.objects.get(oid)!;
        if (obj.type !== 'commit') continue;
        const parsed = parseCommit(obj.data);
        for (const p of parsed.parents) {
          if (!haveSet.has(p) && !shallowSet.has(p) && g + 1 <= maxGen) queue.push({ oid: p, g: g + 1 });
        }
      }
      // boundary: sent commits whose parents were not sent (when depth)
      if (depth !== null) {
        for (const oid of order) {
          if (repo.objects.get(oid)?.type !== 'commit') continue;
          const parsed = parseCommit(repo.objects.get(oid)!.data);
          const parentsUnsent = parsed.parents.some((p) => !order.includes(p));
          if (parentsUnsent && !shallowSet.has(oid)) shallowOut.push(oid);
        }
        for (const s of shallowSet) if (order.includes(s)) unshallowOut.push(s);
      }
      // pack objects: closure of sent commits (and loose wants), minus closure of haves/shallow-in
      const excluded = new Set<string>();
      const markReachable = (tip: string): void => {
        const seen = new Set<string>();
        const stack = [tip];
        while (stack.length) {
          const oid = stack.pop()!;
          if (seen.has(oid) || !repo.objects.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid)!;
          if (obj.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
          if (obj.type === 'commit') {
            const tree = /^tree ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
            if (tree) stack.push(tree[1]!);
          }
          if (obj.type === 'tag') {
            const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
            if (m) stack.push(m[1]!);
          }
          if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
        }
        for (const oid of seen) excluded.add(oid);
      };
      for (const h of haves) markReachable(h);
      for (const s of shallowSet) markReachable(s);
      const included = new Set<string>();
      const addClosure = (tip: string): void => {
        const stack = [tip];
        while (stack.length) {
          const oid = stack.pop()!;
          if (included.has(oid) || !repo.objects.has(oid)) continue;
          included.add(oid);
          const obj = repo.objects.get(oid)!;
          if (obj.type === 'commit') {
            for (const p of parseCommit(obj.data).parents) if (!excluded.has(p)) stack.push(p);
            const tree = /^tree ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
            if (tree && !excluded.has(tree[1]!)) stack.push(tree[1]!);
          } else if (obj.type === 'tag') {
            const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
            if (m) stack.push(m[1]!);
          } else if (obj.type === 'tree') {
            for (const e of parseTree(obj.data)) if (!excluded.has(e.oid)) stack.push(e.oid);
          }
        }
      };
      for (const w of wants) addClosure(w);
      for (const oid of order) addClosure(oid);
      included.delete('');
      sendObjects = [...included].filter((oid) => !excluded.has(oid) && repo.objects.has(oid));
      if (depth !== null) {
        // a shallow fetch must not send parents beyond the boundary: excluded already covers
        // shallow-in closures; the boundary commits' parents were never added (g > maxGen).
      }
    } else {
      // negotiation without done: acknowledge common objects and send nothing yet
      out.push(pktLine('acknowledgments\n'));
      let common = false;
      for (const h of haves) {
        if (repo.objects.has(h)) { out.push(pktLine(`ACK ${h}\n`)); common = true; }
      }
      out.push(pktLine('NAK\n'));
      void common;
      out.push(flushPkt());
      bytes(ctx.res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out), ctx.requestId);
      return;
    }

    // build response: shallow-info (when shallow/deepen), then packfile section
    if (depth !== null) {
      out.push(pktLine('shallow-info\n'));
      for (const s of shallowOut) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallowOut) out.push(pktLine(`unshallow ${s}\n`));
    }
    const entries: GitObject[] = sendObjects.map((oid) => {
      const obj = repo.objects.get(oid)!;
      return { type: obj.type, data: obj.data, oid, deltaOf: obj.deltaOf, delta: obj.delta };
    });
    const included = new Set(entries.map((e) => e.oid));
    const pack = buildPackExact(entries, included);
    out.push(pktLine('packfile\n'));
    // sideband framing for the packfile section (band 1 = data, band 2 = progress)
    const CHUNK = 65519;
    for (let i = 0; i < pack.length; i += CHUNK) {
      out.push(sidebandBand(pack.subarray(i, Math.min(i + CHUNK, pack.length)), 1));
    }
    if (!noProgress) out.push(sidebandBand(Buffer.from('done\n', 'utf8'), 2));
    out.push(flushPkt());
    bytes(ctx.res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out), ctx.requestId);
    return;
  }

  bytes(ctx.res, 400, 'application/x-git-upload-pack-result', pktLine('ERR unknown command\n'), ctx.requestId);
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(ctx: Ctx, owner: string, repoNameGit: string): void {
  const repo = gitRepo(owner, repoNameGit);
  if (!repo) { sendError(ctx, 404, 'Not Found'); return; }
  const body = ctx.body;
  const { pkts, rest } = readPkts(body);
  interface Cmd { old: string; new: string; ref: string; caps: string[]; }
  const cmds: Cmd[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') break;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const caps = nul >= 0 ? text.slice(nul + 1).replace(/\n$/, '').split(' ').filter(Boolean) : [];
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (m) cmds.push({ old: m[1]!, new: m[2]!, ref: m[3]!, caps });
    if (nul >= 0 && cmds.length === 0) break;
  }
  const packBytes = rest;
  const caps = cmds[0]?.caps ?? [];
  const sideband = caps.includes('side-band-64k');

  // apply the pack first (even an empty one is valid)
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes);
      for (const o of objects) {
        const full: GitObject = { type: o.type as ObjType, data: o.data };
        if (o.deltaOf && !o.deltaOf.startsWith('@')) {
          full.deltaOf = o.deltaOf;
          full.delta = o.delta;
        }
        repo.putObject(full, o.oid);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const verdicts: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackOk) {
    for (const cmd of cmds) {
      if (cmd.new === ZERO) {
        // delete
        if (!caps.includes('delete-refs')) { verdicts.push({ ref: cmd.ref, ok: false, reason: 'delete-refs not permitted' }); continue; }
        const current = repo.refSha(cmd.ref);
        if (current === undefined) { verdicts.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' }); continue; }
        if (cmd.old !== ZERO && cmd.old !== current) { verdicts.push({ ref: cmd.ref, ok: false, reason: 'unexpected old value' }); continue; }
        repo.refs.delete(cmd.ref);
        verdicts.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (!repo.objects.has(cmd.new)) { verdicts.push({ ref: cmd.ref, ok: false, reason: 'missing necessary objects' }); continue; }
      const current = repo.refSha(cmd.ref);
      if (cmd.old === ZERO) {
        if (current !== undefined) { verdicts.push({ ref: cmd.ref, ok: false, reason: 'reference already exists' }); continue; }
        repo.refs.set(cmd.ref, cmd.new);
        verdicts.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (current === undefined || cmd.old !== current) { verdicts.push({ ref: cmd.ref, ok: false, reason: 'unexpected old value' }); continue; }
      if (!isAncestor(repo, cmd.old, cmd.new)) { verdicts.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      repo.refs.set(cmd.ref, cmd.new);
      verdicts.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  } else {
    for (const cmd of cmds) verdicts.push({ ref: cmd.ref, ok: false, reason: 'unpacker error' });
  }

  // build the report-status stream (pkt-framed lines)
  const report: Buffer[] = [];
  report.push(pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`));
  for (const v of verdicts) {
    report.push(pktLine(v.ok ? `ok ${v.ref}\n` : `ng ${v.ref} ${v.reason}\n`));
  }
  report.push(flushPkt());
  const reportBytes = Buffer.concat(report);

  const chunks: Buffer[] = [];
  if (sideband) {
    const CHUNK = 65519;
    for (let i = 0; i < reportBytes.length; i += CHUNK) {
      chunks.push(sidebandBand(reportBytes.subarray(i, Math.min(i + CHUNK, reportBytes.length)), 1));
    }
    chunks.push(flushPkt());
  } else {
    chunks.push(reportBytes);
  }
  bytes(ctx.res, 200, 'application/x-git-receive-pack-result', Buffer.concat(chunks), ctx.requestId);
}

function isAncestor(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const seen = new Set<string>();
  const stack = [newOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === oldOid) return true;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}
