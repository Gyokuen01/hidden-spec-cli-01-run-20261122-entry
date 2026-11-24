// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves: new path -> old path, for the R output line. */
  readonly moves = new Map<string, string>();
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
}

type Edit = (tree: Tree) => void;

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

/* ------------------------------------------------------------------ */
/* Files, lines, matching (SPEC.md sections 3 and 5)                   */
/* ------------------------------------------------------------------ */

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

interface FileParts {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: '\r\n' | '\n', final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A line of O or N: `ctx` marks a context line (written as the file's own matched line). */
interface PLine {
  text: string;
  ctx: boolean;
}

/** Positions (0-based) where O occurs in `lines` at the given tier. */
function occurrencesAt(o: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const norm = (s: string): string => (tier === 0 ? s : tier === 1 ? trimEndWs(s) : trimWs(s));
  const on = o.map(norm);
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(lines[i + j]!) !== on[j]!) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2) at which O occurs, with its positions; null when none. `strict` tries tier 0 only. */
function findTier(o: string[], lines: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(o, lines, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Build the lines that replace O at `pos`: context lines come from the file, other lines are re-indented at tier 2. */
function buildReplacement(o: PLine[], n: PLine[], lines: string[], pos: number, tier: number): string[] {
  const oCtxIdx: number[] = [];
  o.forEach((l, i) => {
    if (l.ctx) oCtxIdx.push(i);
  });
  let ctxSeen = 0;
  const out: string[] = [];
  for (const l of n) {
    if (l.ctx) {
      out.push(lines[pos + oCtxIdx[ctxSeen]!]!);
      ctxSeen += 1;
    } else if (tier === 2 && o.length > 0) {
      const f = leadWs(lines[pos]!);
      const p = leadWs(o[0]!.text);
      if (l.text !== '' && l.text.trim() !== '' && l.text.startsWith(p)) out.push(f + l.text.slice(p.length));
      else out.push(l.text);
    } else {
      out.push(l.text);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9) — as the starter had them            */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
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
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\' | '';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** Path after `--- ` / `+++ `: text after the four characters, up to the first tab, surrounding spaces removed. */
function diffPath(raw: string): string | null {
  const t = raw.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const startSection = (oldPath: string | null, newPath: string | null): Section => {
    const s: Section = { oldPath, newPath, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      // A `diff --git` line is `diff --git a/<X> b/<Y>`; trailing spaces or tabs after it
      // do not change the form, but a path with a space in it is not of the form.
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection(m[1]!, m[2]!);
      i += 1;
      i = parseUnifiedHeader(lines, i, s);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection(null, null);
      i = parseUnifiedHeader(lines, i, s);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Parse a section's header (starting at `i`) and its hunks; returns the index after the section. */
function parseUnifiedHeader(lines: string[], i: number, s: Section): number {
  let sawDashPair = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sawDashPair) break;
        s.oldPath = diffPath(l);
        s.newPath = diffPath(lines[i + 1]!);
        sawDashPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (!sawDashPair) s.oldPath = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!sawDashPair) s.newPath = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      s.isCreate = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      s.isDelete = true;
      i += 1;
      continue;
    }
    // index, old mode, new mode, similarity index, dissimilarity index, Index:, and any other line: ignored.
    i += 1;
  }
  // Hunks.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (!l.startsWith('@@')) {
      // Lines outside a body that are not part of a section header are ignored.
      i += 1;
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
    i += 1;
    while (i < lines.length) {
      const b = lines[i]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
        hunk.body.push({ kind: b[0] as ' ' | '-' | '+' | '\\', text: b.slice(1) });
        i += 1;
        continue;
      }
      if (b === '') {
        hunk.body.push({ kind: '', text: '' });
        i += 1;
        continue;
      }
      break;
    }
    // Empty lines at the end of a body are not part of it.
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === '') hunk.body.pop();
    s.hunks.push(hunk);
  }
  return i;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = s.isCreate || oldP === null;
    const isDelete = s.isDelete || newP === null;
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let backslash = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const body = s.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi--) {
          if (body[bi]!.kind === '+') {
            backslash = bi + 1 < body.length && body[bi + 1]!.kind === '\\';
            hi = -1;
            break;
          }
        }
      }
      const content = plus.length === 0 ? '' : plus.join('\n') + (backslash ? '' : '\n');
      tree.now.set(newP, content);
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const from = oldP!;
    const to = isMove ? newP! : oldP!;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (isMove && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    const fp = splitFile(before);
    let fileLines = fp.lines;
    let final = fp.final;
    let d = 0;
    for (const h of s.hunks) {
      const o: PLine[] = [];
      const n: PLine[] = [];
      for (const b of h.body) {
        if (b.kind === ' ' || b.kind === '') {
          o.push({ text: b.text, ctx: true });
          n.push({ text: b.text, ctx: true });
        } else if (b.kind === '-') o.push({ text: b.text, ctx: false });
        else if (b.kind === '+') n.push({ text: b.text, ctx: false });
      }
      let backslash = false;
      for (let bi = h.body.length - 1; bi >= 0; bi--) {
        const k = h.body[bi]!.kind;
        if (k === ' ' || k === '' || k === '+') {
          backslash = bi + 1 < h.body.length && h.body[bi + 1]!.kind === '\\';
          break;
        }
      }
      const oTexts = o.map((x) => x.text);
      if (o.length > 0) {
        const found = findTier(oTexts, fileLines, strict);
        if (found === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of found.positions) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const atEnd = best + o.length === fileLines.length;
        const repl = buildReplacement(o, n, fileLines, best, found.tier);
        fileLines = [...fileLines.slice(0, best), ...repl, ...fileLines.slice(best + o.length)];
        if (atEnd) final = !backslash;
        d += n.length - o.length;
      } else {
        const insertAt = Math.max(0, Math.min(h.a + d, fileLines.length));
        const atEnd = insertAt === fileLines.length;
        const repl = n.map((x) => x.text);
        fileLines = [...fileLines.slice(0, insertAt), ...repl, ...fileLines.slice(insertAt)];
        if (atEnd) final = !backslash;
        d += n.length;
      }
    }
    const content = joinFile(fileLines, fp.br, final);
    if (isMove) {
      tree.now.set(to, content);
      tree.now.set(from, null);
      tree.moves.set(to, from);
    } else {
      tree.now.set(from, content);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  searchLine: number;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, searchLine: s + 1, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevReplaceEnd = rep;
    prevPath = path;
    i = rep;
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
      tree.now.set(p, content);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const fp = splitFile(before);
    const found = findTier(b.oldLines, fp.lines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const o: PLine[] = b.oldLines.map((t) => ({ text: t, ctx: false }));
    const n: PLine[] = b.newLines.map((t) => ({ text: t, ctx: false }));
    const repl = buildReplacement(o, n, fp.lines, pos, found.tier);
    const fileLines = [...fp.lines.slice(0, pos), ...repl, ...fp.lines.slice(pos + b.oldLines.length)];
    tree.now.set(p, joinFile(fileLines, fp.br, fp.final));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  o: PLine[];
  n: PLine[];
}
interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
  line: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  const sectionStart = (l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice('*** Delete File: '.length).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice('*** Update File: '.length).trim() };
    return null;
  };
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const ss = sectionStart(l);
    if (ss === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: V4ASection = { kind: ss.kind, path: ss.path, moveTo: null, lines: [], chunks: [], line: i + 1 };
    sections.push(sec);
    i += 1;
    const contentStart = i;
    let contentEnd = i;
    while (contentEnd < last) {
      const cl = lines[contentEnd]!;
      if (sectionStart(cl) !== null) break;
      contentEnd += 1;
    }
    const raw = lines.slice(contentStart, contentEnd);
    let end = raw.length;
    while (end > 0 && blank(raw[end - 1]!)) end -= 1;
    const content = raw.slice(0, end);
    if (sec.kind === 'add') {
      for (let k = 0; k < content.length; k++) {
        const cl = content[k]!;
        if (cl.startsWith('+')) sec.lines.push(cl.slice(1));
        else if (cl === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${contentStart + k + 1}`);
      }
    } else if (sec.kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${contentStart + 1}`);
    } else {
      let idx = 0;
      if (content.length > 0 && content[0]!.startsWith('*** Move to: ')) {
        sec.moveTo = content[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      let cur: V4AChunk | null = null;
      const finishChunk = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < content.length; idx++) {
        const cl = content[idx]!;
        if (cl.startsWith('@@')) {
          finishChunk();
          const anchorText = cl.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, o: [], n: [] };
          continue;
        }
        if (cl === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, o: [], n: [] };
          cur.eof = true;
          finishChunk();
          continue;
        }
        if (cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+') || cl === '') {
          if (cur === null) cur = { anchor: null, eof: false, o: [], n: [] };
          if (cl.startsWith(' ')) {
            cur.o.push({ text: cl.slice(1), ctx: true });
            cur.n.push({ text: cl.slice(1), ctx: true });
          } else if (cl.startsWith('-')) cur.o.push({ text: cl.slice(1), ctx: false });
          else if (cl.startsWith('+')) cur.n.push({ text: cl.slice(1), ctx: false });
          else {
            cur.o.push({ text: '', ctx: true });
            cur.n.push({ text: '', ctx: true });
          }
          continue;
        }
        throw new Exit2(`error: parse ${contentStart + idx + 1}`);
      }
      finishChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
    i = contentEnd;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4ASection, strict: boolean): Edit {
  return (tree) => {
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content = s.lines.length === 0 ? '' : s.lines.join('\n') + '\n';
      tree.now.set(p, content);
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // SPEC section 10: every path an edit names is checked for safety before anything else
    // about it, so the destination of a move is safety-checked before the old file's existence.
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const fp = splitFile(before);
    let fileLines = fp.lines;
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const anchor = chunk.anchor;
        let foundLine: number | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const norm = (x: string): string => (t === 0 ? x : t === 1 ? trimEndWs(x) : trimWs(x));
          for (let j = cursor; j < fileLines.length; j++) {
            if (norm(fileLines[j]!) === norm(anchor)) {
              foundLine = j;
              break;
            }
          }
          if (foundLine !== null) break;
        }
        if (foundLine === null) throw new Fail('no-match', p);
        cursor = foundLine + 1;
      }
      const oTexts = chunk.o.map((x) => x.text);
      if (oTexts.length === 0) {
        const insertAt = chunk.eof ? fileLines.length : cursor;
        const repl = chunk.n.map((x) => x.text);
        fileLines = [...fileLines.slice(0, insertAt), ...repl, ...fileLines.slice(insertAt)];
        cursor = insertAt + repl.length;
        continue;
      }
      const found = findTier(oTexts, fileLines, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let pos: number | null = null;
      for (const cand of found.positions) {
        if (chunk.eof && cand + oTexts.length !== fileLines.length) continue;
        pos = cand;
        break;
      }
      if (pos === null) throw new Fail('no-match', p);
      const repl = buildReplacement(chunk.o, chunk.n, fileLines, pos, found.tier);
      fileLines = [...fileLines.slice(0, pos), ...repl, ...fileLines.slice(pos + oTexts.length)];
      cursor = pos + repl.length;
    }
    const content = joinFile(fileLines, fp.br, fp.final);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, content);
      tree.now.set(p, null);
      tree.moves.set(s.moveTo, p);
    } else {
      tree.now.set(p, content);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Run (SPEC.md sections 1, 2, 10)                                     */
/* ------------------------------------------------------------------ */

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
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [to, from] of tree.moves) {
    const wasFrom = tree.original(from);
    const nowFrom = tree.now.get(from);
    const wasTo = tree.original(to);
    const nowTo = tree.now.get(to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      covered.add(from);
      covered.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  if (!check) {
    for (const [to, from] of tree.moves) {
      if (!covered.has(to)) continue;
      const nowTo = tree.now.get(to);
      if (nowTo !== null) {
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, nowTo);
      }
      rmSync(from, { force: true });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
