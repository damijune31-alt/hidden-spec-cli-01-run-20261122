// mend: one CLI that applies AI-written edits in four formats to a tree of
// text files, exactly as SPEC.md (version 1) in the kit's starter says.
// Node 22+, standard library only. Run as `node main.ts [options] [PATCH]`.
// Written from the specification; the trial hand-over at the end is kept so
// the kit's runner can drive it in a trial.
//
// Layout of this file:
//   1. command line, output and exit codes (SPEC sections 1-2)
//   2. files, lines, paths and three-tier matching (sections 3 and 5)
//   3. JSON edits (section 9) -- the other three formats live in the
//      parsers further down (sections 6, 7, 8)
//   4. order and atomicity, and the all-or-nothing write (section 10)

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file split into its lines under its own line break. */
interface FileParts {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let finalBr = false;
  if (text.endsWith(br)) {
    lines.pop();
    finalBr = true;
  }
  return { br, lines, finalBr };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.finalBr ? p.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const normAt = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s));

/** Every 0-based position where O occurs in lines at one tier (overlaps count). */
function occsAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normAt(lines[i + j]!, tier) !== normAt(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with all its occurrences. */
function findMatch(lines: string[], o: string[], strict: boolean): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs = occsAt(lines, o, t);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/**
 * The lines that replace a match: context lines come from the file's own
 * matched lines (ctxMap: N index -> O index); every other line of N is
 * re-indented at tier 2 and written as it is at tiers 0 and 1.
 */
function buildOut(fileLines: string[], pos: number, o: string[], n: string[], ctxMap: Map<number, number>, tier: number): string[] {
  const out: string[] = [];
  if (tier === 2) {
    const f = leadWs(fileLines[pos] ?? '');
    const p = leadWs(o[0] ?? '');
    for (let i = 0; i < n.length; i += 1) {
      if (ctxMap.has(i)) {
        out.push(fileLines[pos + ctxMap.get(i)!]!);
        continue;
      }
      const t = n[i]!;
      if (t === '' || /^[ \t]+$/.test(t)) {
        out.push(t);
        continue;
      }
      out.push(t.startsWith(p) ? f + t.slice(p.length) : t);
    }
    return out;
  }
  for (let i = 0; i < n.length; i += 1) {
    out.push(ctxMap.has(i) ? fileLines[pos + ctxMap.get(i)!]! : n[i]!);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  parts(p: string): FileParts | null {
    const t = this.get(p);
    return t === null ? null : splitFile(t);
  }
  setText(p: string, text: string): void {
    this.now.set(p, text);
  }
  setParts(p: string, parts: FileParts): void {
    this.now.set(p, joinFile(parts));
  }
  remove(p: string): void {
    this.now.set(p, null);
  }
}

interface MoveRec {
  old: string;
  nw: string;
}

type Edit = (tree: Tree, moves: MoveRec[]) => void;

function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

/** Read a file the edit needs, failing `missing` when it is not there. */
function needFile(tree: Tree, p: string): string {
  needSafe(p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.setText(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.setText(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needFile(tree, p);
      const parts = splitFile(before);
      if (line < 0 || line > parts.lines.length) throw new Fail('no-match', p);
      parts.lines.splice(line, 0, ...add);
      tree.setParts(p, parts);
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- format parsers for sections 6, 7 and 8 (filled in next) ----

// ---- unified diffs (SPEC section 6) ----

interface HunkItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  a: number;
  items: HunkItem[];
  o: string[];
  n: string[];
  ctxMap: Map<number, number>;
  /** a `\` line follows the hunk's last context or `+` line */
  bsAfterLast: boolean;
  /** a `\` line follows the hunk's last `+` line */
  bsAfterLastPlus: boolean;
}

function makeHunk(a: number, body: string[]): Hunk {
  const items: HunkItem[] = body.map((b) => {
    if (b === '') return { kind: 'ctx', text: '' };
    if (b[0] === ' ') return { kind: 'ctx', text: b.slice(1) };
    if (b[0] === '-') return { kind: 'old', text: b.slice(1) };
    if (b[0] === '+') return { kind: 'new', text: b.slice(1) };
    return { kind: 'bs', text: b.slice(1) };
  });
  const o: string[] = [];
  const n: string[] = [];
  const ctxMap = new Map<number, number>();
  for (const it of items) {
    if (it.kind === 'ctx') {
      ctxMap.set(n.length, o.length);
      o.push(it.text);
      n.push(it.text);
    } else if (it.kind === 'old') o.push(it.text);
    else if (it.kind === 'new') n.push(it.text);
  }
  let lastCtxOrNew = -1;
  let lastNew = -1;
  for (let k = 0; k < items.length; k += 1) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') lastCtxOrNew = k;
    if (items[k]!.kind === 'new') lastNew = k;
  }
  return {
    a,
    items,
    o,
    n,
    ctxMap,
    bsAfterLast: lastCtxOrNew >= 0 && items[lastCtxOrNew + 1]?.kind === 'bs',
    bsAfterLastPlus: lastNew >= 0 && items[lastNew + 1]?.kind === 'bs',
  };
}

/** Apply a section's hunks in order to the file's split lines. */
function applyHunks(parts: FileParts, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const oldLen = parts.lines.length;
      const at = Math.min(h.a + d, oldLen);
      parts.lines.splice(at, 0, ...h.n);
      if (at === oldLen) parts.finalBr = !h.bsAfterLast;
      d += h.n.length;
      continue;
    }
    const m = findMatch(parts.lines, h.o, strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = m.occs[0]!;
    let bestDist = Math.abs(best - target);
    for (const occ of m.occs) {
      const dist = Math.abs(occ - target);
      if (dist < bestDist) {
        best = occ;
        bestDist = dist;
      }
    }
    const pos = best;
    const runsToEnd = pos + h.o.length === parts.lines.length;
    const out = buildOut(parts.lines, pos, h.o, h.n, h.ctxMap, m.tier);
    parts.lines.splice(pos, h.o.length, ...out);
    if (runsToEnd) parts.finalBr = !h.bsAfterLast;
    d += h.n.length - h.o.length;
  }
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed, prefix stripped. */
function diffPath(s: string): string | null {
  let x = s;
  const tab = x.indexOf('\t');
  if (tab >= 0) x = x.slice(0, tab);
  x = x.trim();
  if (x === '/dev/null') return null;
  if (x.startsWith('a/') || x.startsWith('b/')) x = x.slice(2);
  return x;
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree, moves) => {
    const isCreate = sec.oldPath === null || sec.newFile;
    if (isCreate) {
      const np = sec.newPath;
      if (np === null) throw new Fail('unsafe', '');
      needSafe(np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let bsAfterLastPlus = false;
      let hasPlus = false;
      for (const h of sec.hunks) {
        let hHasPlus = false;
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            hHasPlus = true;
          }
        }
        if (hHasPlus) {
          hasPlus = true;
          bsAfterLastPlus = h.bsAfterLastPlus;
        }
      }
      tree.setText(np, plus.length === 0 ? '' : plus.join('\n') + (hasPlus && !bsAfterLastPlus ? '\n' : ''));
      return;
    }
    const isDelete = sec.newPath === null || sec.deletedFile;
    if (isDelete) {
      const op = sec.oldPath;
      if (op === null) throw new Fail('unsafe', '');
      needSafe(op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.remove(op);
      return;
    }
    const op = sec.oldPath!;
    const np = sec.newPath!;
    const isMove = op !== np;
    needSafe(op);
    needSafe(np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const parts = splitFile(before);
    applyHunks(parts, sec.hunks, strict, op);
    if (isMove) {
      tree.remove(op);
      tree.setParts(np, parts);
      moves.push({ old: op, nw: np });
    } else {
      tree.setParts(op, parts);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const diffRe = /^diff --git a\/([^ ]+) b\/(.+)$/;
  let cur: Section | null = null;
  let inHeader = false;
  let pairSeen = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      pairSeen = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !pairSeen) {
        cur.oldPath = diffPath(line.slice(4));
        cur.newPath = diffPath(lines[i + 1]!.slice(4));
        pairSeen = true;
      } else {
        cur = { oldPath: diffPath(line.slice(4)), newPath: diffPath(lines[i + 1]!.slice(4)), newFile: false, deletedFile: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(makeHunk(Number(hm[1]), body));
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ') && !pairSeen) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !pairSeen) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    needSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.setText(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const m = findMatch(parts.lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.occs.length > 1) throw new Fail('ambiguous', path);
    const out = buildOut(parts.lines, m.occs[0]!, oldLines, newLines, new Map(), m.tier);
    parts.lines.splice(m.occs[0]!, oldLines.length, ...out);
    tree.setParts(path, parts);
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let k = sIdx - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = rep;
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  ctxMap: Map<number, number>;
}

function occsAtFrom(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normAt(lines[i + j]!, tier) !== normAt(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function buildVChunk(anchor: string | null, eof: boolean, items: HunkItem[]): VChunk {
  const o: string[] = [];
  const n: string[] = [];
  const ctxMap = new Map<number, number>();
  for (const it of items) {
    if (it.kind === 'ctx') {
      ctxMap.set(n.length, o.length);
      o.push(it.text);
      n.push(it.text);
    } else if (it.kind === 'old') o.push(it.text);
    else if (it.kind === 'new') n.push(it.text);
  }
  return { anchor, eof, o, n, ctxMap };
}

function v4aUpdateEdit(path: string, raw: string[], startIdx: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let j = 0;
  if (raw[0] !== undefined && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    j = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; items: HunkItem[] } | null = null;
  let firstChunk = true;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(buildVChunk(cur.anchor, cur.eof, cur.items));
      cur = null;
    }
  };
  for (; j < raw.length; j += 1) {
    const l = raw[j]!;
    const lineNo = startIdx + 2 + j;
    if (l.startsWith('@@')) {
      flush();
      cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
      firstChunk = false;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      flush();
      firstChunk = false;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (!firstChunk) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, items: [] };
        firstChunk = false;
      }
      cur.items.push(
        l === ''
          ? { kind: 'ctx', text: '' }
          : l[0] === ' '
            ? { kind: 'ctx', text: l.slice(1) }
            : l[0] === '-'
              ? { kind: 'old', text: l.slice(1) }
              : { kind: 'new', text: l.slice(1) },
      );
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startIdx + 1}`);
  return (tree, moves) => {
    needSafe(path);
    if (moveTo !== null) needSafe(moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let found = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < parts.lines.length; k += 1) {
            if (normAt(parts.lines[k]!, t) === normAt(ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? parts.lines.length : cursor;
        parts.lines.splice(at, 0, ...ch.n);
        cursor = at + ch.n.length;
        continue;
      }
      let m: { tier: number; occs: number[] } | null = null;
      for (const t of strict ? [0] : [0, 1, 2]) {
        const occs = occsAtFrom(parts.lines, ch.o, t, cursor);
        if (occs.length > 0) {
          m = { tier: t, occs };
          break;
        }
      }
      if (m === null) throw new Fail('no-match', path);
      let pos: number | null = null;
      for (const occ of m.occs) {
        if (ch.eof && occ + ch.o.length !== parts.lines.length) continue;
        pos = occ;
        break;
      }
      if (pos === null) throw new Fail('no-match', path);
      const out = buildOut(parts.lines, pos, ch.o, ch.n, ch.ctxMap, m.tier);
      parts.lines.splice(pos, ch.o.length, ...out);
      cursor = pos + out.length;
    }
    if (moveTo !== null) {
      tree.remove(path);
      tree.setParts(moveTo, parts);
      moves.push({ old: path, nw: moveTo });
    } else {
      tree.setParts(path, parts);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSecStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isSecStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const start = i;
    i += 1;
    const raw: string[] = [];
    while (i < last && !isSecStart(lines[i]!)) {
      raw.push(lines[i]!);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      for (let k = 0; k < raw.length; k += 1) {
        if (!(raw[k]!.startsWith('+') || raw[k]! === '')) throw new Exit2(`error: parse ${start + 2 + k}`);
      }
      const content = raw.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push((tree) => {
        needSafe(path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.setText(path, content.length === 0 ? '' : `${content.join('\n')}\n`);
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      if (raw.length > 0) throw new Exit2(`error: parse ${start + 2}`);
      edits.push((tree) => {
        needSafe(path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.remove(path);
      });
    } else {
      const path = line.slice('*** Update File: '.length).trim();
      edits.push(v4aUpdateEdit(path, raw, start, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Output rows for the tree's changed paths, with move pairs as R lines. */
function computeRows(tree: Tree, moves: MoveRec[]): string[] {
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const eaten = new Set<string>();
  for (const mv of moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const wasNew = tree.original(mv.nw);
    const nowNew = tree.get(mv.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.nw, text: `R ${mv.old} -> ${mv.nw}` });
      eaten.add(mv.old);
      eaten.add(mv.nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (eaten.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  return rows.map((r) => r.text);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: MoveRec[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = computeRows(tree, moves);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const v = tree.now.get(p)!;
      if (v === null || v === tree.original(p)) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
