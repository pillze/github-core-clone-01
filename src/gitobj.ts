// Git object store, pkt-line codec, tree/commit/tag building, packfile read+write.
// Node 22 standard library only.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
  /** When the object arrived as a delta, the base object's sha (kept so clones can reuse deltas). */
  deltaOf?: string;
  /** The raw delta payload against deltaOf. */
  delta?: Buffer;
}

export function shaOfObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function looseBytes(type: ObjType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from(body.length + 4 <= 65536 ? String(body.length + 4).padStart(4, '0') : 'ffff', 'ascii'), body]);
}

export function flushPkt(): Buffer { return Buffer.from('0000', 'ascii'); }
export function delimPkt(): Buffer { return Buffer.from('0001', 'ascii'); }

/** Read pkt-lines from a buffer. Returns data packets, flush/delim markers, and trailing bytes. */
export interface Pkt { kind: 'data' | 'flush' | 'delim'; payload: Buffer; }
export function readPkts(buf: Buffer): { pkts: Pkt[]; rest: Buffer } {
  const pkts: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { pkts, rest: buf.subarray(i) };
    const len = parseInt(hex, 16);
    if (len === 0) { pkts.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { pkts.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) return { pkts, rest: buf.subarray(i) };
    pkts.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { pkts, rest: buf.subarray(i) };
}

export function sidebandBand(payload: Buffer, band: number): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}

// ---------------------------------------------------------------- delta application

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let shift = 0, value = 0;
    for (;;) {
      const b = delta[i++];
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return value >>> 0;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const out = Buffer.alloc(resultSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let offset = 0, size = 0;
      if (op & 0x01) offset |= delta[i++];
      if (op & 0x02) offset |= delta[i++] << 8;
      if (op & 0x04) offset |= delta[i++] << 16;
      if (op & 0x08) offset |= delta[i++] << 24;
      if (op & 0x10) size |= delta[i++];
      if (op & 0x20) size |= delta[i++] << 8;
      if (op & 0x40) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      base.copy(out, o, offset, offset + size);
      o += size;
    } else if (op > 0) {
      delta.copy(out, o, i, i + op);
      i += op;
      o += op;
    } else throw new Error('delta opcode 0');
  }
  if (o !== resultSize) throw new Error(`delta produced ${o} bytes, expected ${resultSize}`);
  return out;
}

// ---------------------------------------------------------------- packfile read

export interface PackEntry { oid: string; type: ObjType; data: Buffer; deltaOf?: string; delta?: Buffer; offset: number; }

export function readPack(pack: Buffer): { objects: PackEntry[]; count: number } {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects: PackEntry[] = [];
  let i = 12;
  for (let n = 0; n < count; n++) {
    const offset = i;
    let c = pack[i++];
    const typeNum = (c >> 4) & 0x7;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) { c = pack[i++]; size |= (c & 0x7f) << shift; shift += 7; }
    let deltaOf: string | undefined;
    let delta: Buffer | undefined;
    if (typeNum === 6) { // OFS_DELTA
      c = pack[i++];
      let off = c & 0x7f;
      while (c & 0x80) { c = pack[i++]; off = ((off + 1) << 7) | (c & 0x7f); }
      const base = objects.find((o) => o.offset === offset - off);
      deltaOf = base ? base.oid : `@${offset - off}`;
      delta = inflateSync(pack.subarray(i, pack.length));
      i += delta.length;
    } else if (typeNum === 7) { // REF_DELTA
      deltaOf = pack.toString('hex', i, i + 20);
      i += 20;
      delta = inflateSync(pack.subarray(i, pack.length));
      i += delta.length;
    } else {
      const type = typeNum === 1 ? 'blob' : typeNum === 2 ? 'tree' : typeNum === 3 ? 'commit' : typeNum === 4 ? 'tag' : null;
      if (type === null) throw new Error(`bad object type ${typeNum} in pack`);
      const data = inflateSync(pack.subarray(i, pack.length));
      i += data.length;
      const oid = shaOfObject(type, data);
      objects.push({ oid, type, data, offset });
      continue;
    }
    objects.push({ oid: '', type: 'blob', data: Buffer.alloc(0), deltaOf, delta, offset });
  }
  // resolve deltas (bases may themselves be deltas)
  const byOid = new Map<string, PackEntry>();
  const byOffset = new Map<number, PackEntry>();
  for (const o of objects) byOffset.set(o.offset, o);
  const resolve = (o: PackEntry, depth = 0): PackEntry => {
    if (o.oid) return o;
    if (depth > 5000) throw new Error('delta chain too deep');
    const baseEntry = o.deltaOf && o.deltaOf.startsWith('@') ? byOffset.get(Number(o.deltaOf.slice(1))) : byOid.get(o.deltaOf ?? '');
    if (!baseEntry) throw new Error(`pack delta base ${o.deltaOf} missing`);
    const base = resolve(baseEntry, depth + 1);
    const data = applyDelta(base.data, o.delta ?? Buffer.alloc(0));
    o.type = base.type;
    o.data = data;
    o.oid = shaOfObject(o.type, data);
    o.deltaOf = base.oid;
    byOid.set(o.oid, o);
    return o;
  };
  for (const o of objects) resolve(o);
  const trailerOk = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex') === pack.toString('hex', pack.length - 20);
  if (!trailerOk) throw new Error('pack trailer sha mismatch');
  return { objects, count };
}

// ---------------------------------------------------------------- packfile write

const TYPE_NUM: Record<ObjType, number> = { blob: 1, tree: 2, commit: 3, tag: 4 };

function objHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let c = (typeNum << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) { bytes.push(c | 0x80); c = size & 0x7f; size >>>= 7; }
  bytes.push(c);
  return Buffer.from(bytes);
}

/** Pack builder; an entry with deltaOf present in `included` emits an OFS_DELTA. */
export function buildPackExact(entries: GitObject[], included: Set<string>): Buffer {
  const bodyChunks: Buffer[] = [];
  const offsets = new Map<string, number>();
  let written = 12;
  interface Pending { entry: GitObject; offset: number; }
  const rendered: Buffer[] = [];
  for (const entry of entries) {
    const useDelta = entry.delta !== undefined && entry.deltaOf !== undefined && included.has(entry.deltaOf);
    let chunk: Buffer;
    if (useDelta) {
      const deltaBuf = entry.delta!;
      const deflated = deflateSync(deltaBuf, { level: 1 });
      const size = deltaBuf.length;
      // varint header for type 6 with size
      const hbytes: number[] = [];
      let c = (6 << 4) | (size & 0x0f);
      let s = size >>> 4;
      while (s > 0) { hbytes.push(c | 0x80); c = s & 0x7f; s >>>= 7; }
      hbytes.push(c);
      const baseOffset = offsets.get(entry.deltaOf!);
      if (baseOffset === undefined) {
        // base not in pack: emit full object instead
        const full = deflateSync(entry.data, { level: 1 });
        chunk = Buffer.concat([Buffer.from(objHeader(TYPE_NUM[entry.type], entry.data.length)), full]);
      } else {
        const rel = written - baseOffset;
        const enc: number[] = [];
        let v = rel;
        enc.push(v & 0x7f); v >>>= 7;
        while (v > 0) { v -= 1; enc.unshift(0x80 | (v & 0x7f)); v >>>= 7; }
        chunk = Buffer.concat([Buffer.from(hbytes), Buffer.from(enc), deflated]);
      }
    } else {
      const deflated = deflateSync(entry.data, { level: 1 });
      chunk = Buffer.concat([Buffer.from(objHeader(TYPE_NUM[entry.type], entry.data.length)), deflated]);
    }
    offsets.set(entry.oid, written);
    rendered.push(chunk);
    written += chunk.length;
  }
  void bodyChunks;
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const head = Buffer.concat([header, ...rendered]);
  const trailer = createHash('sha1').update(head).digest();
  return Buffer.concat([head, trailer]);
}

// ---------------------------------------------------------------- trees, commits, tags

export interface TreeSpec { path: string; oid: string; mode: string; } // mode: '100644' | '100755' | '40000'

interface TreeNode { name: string; mode: string; oid?: string; children: Map<string, TreeNode>; }

export function buildTree(specs: TreeSpec[]): { oid: string; data: Buffer } {
  const root: TreeNode = { name: '', mode: '40000', children: new Map() };
  for (const spec of specs) {
    const parts = spec.path.split('/').filter((p) => p !== '');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const leaf = i === parts.length - 1;
      let child = node.children.get(name);
      if (!child) { child = { name, mode: leaf ? spec.mode : '40000', children: new Map() }; node.children.set(name, child); }
      if (leaf) { child.mode = spec.mode; child.oid = spec.oid; }
      node = child;
    }
  }
  const render = (node: TreeNode): Buffer => {
    const entries: { mode: string; name: string; oid: string; sortKey: string }[] = [];
    for (const child of node.children.values()) {
      if (child.children.size > 0 || (!child.oid && child.mode === '40000')) {
        const data = render(child);
        const oid = shaOfObject('tree', data);
        entries.push({ mode: '40000', name: child.name, oid, sortKey: `${child.name}/` });
      } else if (child.oid) {
        entries.push({ mode: child.mode, name: child.name, oid: child.oid, sortKey: child.name });
      }
    }
    entries.sort((a, b) => Buffer.from(a.sortKey, 'utf8').compare(Buffer.from(b.sortKey, 'utf8')));
    const chunks: Buffer[] = [];
    for (const e of entries) {
      chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      chunks.push(Buffer.from(e.oid, 'hex'));
    }
    return Buffer.concat(chunks);
  };
  const data = render(root);
  return { oid: shaOfObject('tree', data), data };
}

export function buildCommit(opts: {
  tree: string; parents: string[]; message: string; authorName: string; authorEmail: string; ts: number;
}): { oid: string; data: Buffer } {
  const who = `${opts.authorName} <${opts.authorEmail}> ${opts.ts} +0000`;
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '', opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`);
  const data = Buffer.from(lines.join('\n'), 'utf8');
  return { oid: shaOfObject('commit', data), data };
}

export function buildTag(opts: {
  object: string; type: ObjType; tag: string; message: string; taggerName: string; taggerEmail: string; ts: number;
}): { oid: string; data: Buffer } {
  const data = Buffer.from(
    [`object ${opts.object}`, `type ${opts.type}`, `tag ${opts.tag}`,
     `tagger ${opts.taggerName} <${opts.taggerEmail}> ${opts.ts} +0000`, '', opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`].join('\n'),
    'utf8',
  );
  return { oid: shaOfObject('tag', data), data };
}

// ---------------------------------------------------------------- parsing

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; author: string; committer: string; ts: number } {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = text.slice(0, headerEnd < 0 ? text.length : headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  let tree = ''; const parents: string[] = []; let ts = 0; let author = ''; let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const m = /\s(\d{9,12})\s+[+-]\d{4}$/.exec(committer || author);
  if (m) ts = Number(m[1]);
  return { tree, parents, message, author, committer, ts };
}

export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const out: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    let space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('ascii', i, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}