import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildWorkspaceSummaries,
  decodeWorkspacePath,
  formatDisplayPath,
  makeWorkspaceId,
  readConversationDbMetadata,
} from './workspaces.mjs';

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);
const QUESTION_TOOLS = new Set(['ask_user_question', 'ask_question']);
const IGNORED_ARTIFACT_ENTRIES = new Set([
  '.system_generated',
  '.user_uploaded',
  'scratch',
  'browser_sandbox',
]);
const ALLOWED_ARTIFACT_EXTS = new Set([
  '.html', '.htm', '.md', '.txt', '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov', '.pdf', '.svg',
]);

export function getDefaultGeminiDirs(homeDir = os.homedir()) {
  const base = path.join(homeDir, '.gemini');
  return {
    brainRoots: [
      { surface: 'desktop', dir: path.join(base, 'antigravity', 'brain') },
      { surface: 'cli', dir: path.join(base, 'antigravity-cli', 'brain') },
      { surface: 'ide', dir: path.join(base, 'antigravity-ide', 'brain') },
    ],
    dbPaths: [
      { surface: 'desktop', path: path.join(base, 'antigravity', 'conversation_summaries.db') },
      { surface: 'cli', path: path.join(base, 'antigravity-cli', 'conversation_summaries.db') },
    ],
  };
}

export function cleanUserRequest(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw;
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match) {
    text = match[1];
  } else {
    text = text
      .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, ' ')
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, ' ')
      .replace(/<DESKTOP_HANDOFF_CONTEXT[^>]*>[\s\S]*?<\/DESKTOP_HANDOFF_CONTEXT>/gi, ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

export function cleanLineNoise(line) {
  return line
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/gi, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?，。；：、])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(?:GitHub Actions\s*)?\bRun\s+\d{7,}\b/gi, '')
    .replace(/\b[a-f0-9]{32,64}\b/gi, '')
    .replace(/[（(]\s*(?:\d[\d,]*\s*(?:bytes|B|字节)|SHA-?256[:：]?\s*)[)）]/gi, '')
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。；：、,.])/g, '$1')
    .trim();
}

function isTableSeparatorLine(line) {
  return /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(line) && line.includes('-');
}

function isTableRowLine(line) {
  const s = line.trim();
  return s.startsWith('|') && s.endsWith('|') && s.includes('|', 1);
}

export function formatReadableExcerpt(raw, maxLen = 280) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const withoutCode = raw
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*[-_*]{3,}\s*$/gm, '');

  const rawLines = withoutCode.split('\n');
  const classified = rawLines.map((line) => ({
    raw: line,
    isSep: isTableSeparatorLine(line),
    isRow: !isTableSeparatorLine(line) && isTableRowLine(line),
  }));
  const proseCount = classified.filter((item) => {
    const t = item.raw.trim();
    return t && !item.isSep && !item.isRow;
  }).length;

  const outLines = [];
  for (let i = 0; i < classified.length; i += 1) {
    const item = classified[i];
    const trimmed = item.raw.trim();
    if (!trimmed) continue;
    if (item.isSep) continue;
    if (item.isRow) {
      const nextIsSep = i + 1 < classified.length && classified[i + 1].isSep;
      if (nextIsSep) continue;
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => cleanLineNoise(c))
        .filter(Boolean);
      if (cells.length === 0) continue;
      if (proseCount >= 2 && cells.length >= 3) continue;
      outLines.push(cells.slice(0, 3).join(' · '));
      continue;
    }
    const cleaned = cleanLineNoise(trimmed);
    if (cleaned) outLines.push(cleaned);
  }

  let result = outLines.join(' ').replace(/\s+/g, ' ').trim();
  if (maxLen > 0 && result.length > maxLen) {
    result = result.slice(0, Math.max(1, maxLen - 1)).trimEnd() + '…';
  }
  return result;
}

export function inferArtifactKind(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.mp4' || ext === '.mov') return 'video';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.gif' || ext === '.svg') return 'image';
  if (ext === '.md' || ext === '.txt') return 'markdown';
  if (ext === '.pdf') return 'pdf';
  return 'file';
}

const MAX_ARTIFACT_CACHE = 128;
const artifactDirCache = new Map();

function listBrainArtifacts(brainDir, signArtifactPath) {
  if (!brainDir) return [];
  let dirStat;
  try {
    dirStat = fs.statSync(brainDir);
    if (!dirStat.isDirectory()) return [];
  } catch {
    return [];
  }

  const hasSigner = typeof signArtifactPath === 'function';
  const now = Date.now();
  const ticketBucket = Math.ceil((now + 24 * 60 * 60 * 1000) / (6 * 60 * 60 * 1000));
  const cached = artifactDirCache.get(brainDir);
  if (
    cached &&
    cached.mtimeMs === dirStat.mtimeMs &&
    cached.ticketBucket === ticketBucket &&
    cached.hasSigner === hasSigner &&
    (now - cached.cachedAtMs) < 15_000
  ) {
    artifactDirCache.delete(brainDir);
    artifactDirCache.set(brainDir, cached);
    return cached.items;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const ent of entries) {
    if (
      IGNORED_ARTIFACT_ENTRIES.has(ent.name) ||
      ent.name.startsWith('.') ||
      ent.name.endsWith('.metadata.json') ||
      ent.name.endsWith('.resolved')
    ) {
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    if (!ALLOWED_ARTIFACT_EXTS.has(ext)) continue;
    const full = path.join(brainDir, ent.name);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      const item = {
        name: ent.name,
        kind: inferArtifactKind(ent.name),
        sizeBytes: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        path: full,
      };
      if (hasSigner) {
        item.previewPath = signArtifactPath(full, ent.name);
      }
      items.push(item);
    } catch {}
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (artifactDirCache.size >= MAX_ARTIFACT_CACHE) {
    const oldestKey = artifactDirCache.keys().next().value;
    if (oldestKey !== undefined) artifactDirCache.delete(oldestKey);
  }
  artifactDirCache.set(brainDir, {
    mtimeMs: dirStat.mtimeMs,
    ticketBucket,
    hasSigner,
    cachedAtMs: now,
    items,
  });
  return items;
}

function parseTimestampMs(iso) {
  if (typeof iso !== 'string' || !iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

const MAX_TRANSCRIPT_CACHE = 128;
const transcriptStepCache = new Map();

function parseTranscriptSteps(transcriptPath) {
  const st = fs.statSync(transcriptPath);
  const cached = transcriptStepCache.get(transcriptPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    // Refresh LRU order
    transcriptStepCache.delete(transcriptPath);
    transcriptStepCache.set(transcriptPath, cached);
    return { st, steps: cached.steps };
  }

  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n');
  const steps = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      steps.push(JSON.parse(line));
    } catch {}
  }

  if (transcriptStepCache.size >= MAX_TRANSCRIPT_CACHE) {
    const oldestKey = transcriptStepCache.keys().next().value;
    if (oldestKey !== undefined) transcriptStepCache.delete(oldestKey);
  }
  transcriptStepCache.set(transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, steps });
  return { st, steps };
}

function formatToolCallBrief(tc) {
  if (!tc || typeof tc.name !== 'string') return '';
  const name = tc.name;
  const args = tc.args || tc.arguments || tc.input || null;
  let obj = args;
  if (typeof args === 'string') {
    try {
      obj = JSON.parse(args);
    } catch {
      obj = null;
    }
  }
  let detail = '';
  if (obj && typeof obj === 'object') {
    const rawPath = obj.Path || obj.path || obj.file_path || obj.TargetFile || obj.DirectoryPath || obj.SearchPath || '';
    const cmd = obj.toolSummary || obj.CommandLine || obj.command || obj.Query || obj.query || obj.Pattern || '';
    if (typeof rawPath === 'string' && rawPath.trim()) {
      detail = path.basename(rawPath.trim());
    } else if (typeof cmd === 'string' && cmd.trim()) {
      detail = cmd.trim().replace(/\s+/g, ' ').slice(0, 48);
    }
  }
  return detail ? `${name} · ${detail}` : name;
}

function parseToolCallArgsObj(tc) {
  const raw = tc?.args ?? tc?.arguments ?? tc?.input ?? null;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? raw : null;
}

function parseAskQuestionToolArgs(args) {
  if (!args || typeof args !== 'object') return null;
  let list = args.questions;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || list.length === 0) return null;

  const normalized = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const question = String(item.question || '').trim();
    if (!question) continue;
    const options = Array.isArray(item.options)
      ? item.options.map((opt) => ({
        value: String(opt),
        label: String(opt),
      }))
      : [];
    normalized.push({
      key: `q${i}`,
      question,
      options,
      isMultiSelect: Boolean(item.is_multi_select ?? item.isMultiSelect),
    });
  }
  return normalized.length > 0 ? normalized : null;
}

function formatQuestionSummaryMarkdown(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return '';
  return questions.map((q, idx) => {
    const header = questions.length > 1 ? `**${idx + 1}. ${q.question}**` : `**${q.question}**`;
    if (!q.options?.length) return header;
    return `${header}\n${q.options.map((o) => `- ${o.label}`).join('\n')}`;
  }).join('\n\n');
}

function extractAnswerLinesFromGeneric(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return '';
  const kept = [];
  for (const rawLine of rawContent.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:Created|Completed) At:/i.test(line)) continue;
    kept.push(line);
  }
  if (kept.length === 0) return '';
  if (!/^A\d+\s*:/i.test(kept[0])) return '';
  return kept.join('\n');
}

function parseAcpElicitationToPendingQuestion(elicitMsg) {
  const schema = elicitMsg?.params?.requestedSchema;
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return null;

  const requiredOrder = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const allKeys = Object.keys(props);
  const orderedKeys = [
    ...requiredOrder.filter((k) => Object.prototype.hasOwnProperty.call(props, k)),
    ...allKeys.filter((k) => !requiredOrder.includes(k)),
  ];

  const extractOptionsFromNode = (node) => {
    if (!node || typeof node !== 'object') return [];
    const choiceList = Array.isArray(node.oneOf)
      ? node.oneOf
      : (Array.isArray(node.anyOf) ? node.anyOf : null);
    if (choiceList) {
      return choiceList
        .filter((entry) => entry && typeof entry === 'object' && entry.const !== undefined)
        .map((entry) => ({
          value: String(entry.const),
          label: String(entry.title ?? entry.const),
        }));
    }
    if (Array.isArray(node.enum)) {
      return node.enum.map((val) => ({
        value: String(val),
        label: String(val),
      }));
    }
    return [];
  };

  const questions = [];
  for (const key of orderedKeys) {
    const prop = props[key];
    if (!prop || typeof prop !== 'object') continue;
    const isMultiSelect = prop.type === 'array';
    const options = isMultiSelect
      ? extractOptionsFromNode(prop.items)
      : extractOptionsFromNode(prop);
    const question = String(prop.title || prop.description || key).trim();
    if (!question) continue;
    questions.push({
      key,
      question,
      options,
      isMultiSelect,
    });
  }

  if (questions.length === 0) return null;
  const message = String(elicitMsg?.params?.message || '').trim() || null;
  return {
    id: `elicit-${elicitMsg.id}`,
    source: 'acp',
    message,
    questions,
  };
}

function findPendingFeedbackArtifact(brainDir, artifacts, turnStartedAtMs) {
  if (!brainDir || !Array.isArray(artifacts) || artifacts.length === 0) return null;
  const cutoffMs = Math.max(0, (turnStartedAtMs || 0) - 2000);
  for (const art of artifacts) {
    if (!art?.name) continue;
    const metaPath = path.join(brainDir, `${art.name}.metadata.json`);
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const wantsFeedback = meta?.requestFeedback === true || meta?.RequestFeedback === true;
      if (!wantsFeedback) continue;
      const metaUpdatedMs = parseTimestampMs(meta?.updatedAt);
      const effectiveMs = Math.max(art.mtimeMs || 0, metaUpdatedMs);
      if (effectiveMs < cutoffMs) continue;
      return {
        name: art.name,
        summary: String(meta?.summary || meta?.Summary || '').trim(),
        previewPath: art.previewPath || null,
      };
    } catch {}
  }
  return null;
}

function readProtoVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    val |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) {
      return {
        val: val <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(val) : Number.MAX_SAFE_INTEGER,
        nextOffset: pos,
      };
    }
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

function extractDesktopPayloadStrings(payloadBuf) {
  let off = 0;
  let prose = '';
  let thought = '';
  while (off < payloadBuf.length) {
    const tagRes = readProtoVarint(payloadBuf, off);
    if (!tagRes || tagRes.val === 0) break;
    off = tagRes.nextOffset;
    const field = tagRes.val >>> 3;
    const wire = tagRes.val & 7;
    if (wire === 0) {
      const v = readProtoVarint(payloadBuf, off);
      if (!v) break;
      off = v.nextOffset;
    } else if (wire === 1) {
      off += 8;
    } else if (wire === 5) {
      off += 4;
    } else if (wire === 2) {
      const lenRes = readProtoVarint(payloadBuf, off);
      if (!lenRes || lenRes.val < 0 || off + lenRes.val > payloadBuf.length) break;
      off = lenRes.nextOffset;
      const sub = payloadBuf.subarray(off, off + lenRes.val);
      off += lenRes.val;
      if (field === 20) {
        let sOff = 0;
        while (sOff < sub.length) {
          const sTag = readProtoVarint(sub, sOff);
          if (!sTag || sTag.val === 0) break;
          sOff = sTag.nextOffset;
          const sf = sTag.val >>> 3;
          const sw = sTag.val & 7;
          if (sw === 0) {
            const sv = readProtoVarint(sub, sOff);
            if (!sv) break;
            sOff = sv.nextOffset;
          } else if (sw === 1) {
            sOff += 8;
          } else if (sw === 5) {
            sOff += 4;
          } else if (sw === 2) {
            const sl = readProtoVarint(sub, sOff);
            if (!sl || sl.val < 0 || sOff + sl.val > sub.length) break;
            sOff = sl.nextOffset;
            const chunk = sub.subarray(sOff, sOff + sl.val);
            sOff += sl.val;
            if (sf === 1) prose = chunk.toString('utf8').trim();
            else if (sf === 3) thought = chunk.toString('utf8').trim();
          } else {
            break;
          }
        }
      }
    } else {
      break;
    }
  }
  return { prose, thought };
}

function readLiveDesktopStreamingStep(brainDir, conversationId) {
  if (!brainDir || !conversationId) return '';
  const geminiRoot = path.dirname(path.dirname(brainDir));
  const convDbPath = path.join(geminiRoot, 'conversations', `${conversationId}.db`);
  if (!fs.existsSync(convDbPath)) return '';
  let db = null;
  try {
    db = new DatabaseSync(convDbPath, { open: true, readOnly: true, timeout: 150 });
    const row = db.prepare('SELECT step_type, status, step_payload FROM steps ORDER BY idx DESC LIMIT 1').get();
    if (!row || row.status !== 8 || !row.step_payload) return '';
    const { prose, thought } = extractDesktopPayloadStrings(Buffer.from(row.step_payload));
    const candidate = prose || (thought ? `💭 ${thought}` : '');
    if (!candidate || candidate.includes('\ufffd')) return '';
    return candidate;
  } catch {
    return '';
  } finally {
    try { db?.close(); } catch {}
  }
}

/**
 * Parse one conversation transcript into a summary and optionally detailed message list.
 */
export function parseTranscriptConversation(transcriptPath, {
  conversationId,
  surface = 'desktop',
  dbMeta = null,
  handoff = null,
  acpState = null,
  homeDir = os.homedir(),
  signArtifactPath = null,
  nowMs = Date.now(),
  includeMessages = false,
} = {}) {
  const { st, steps } = parseTranscriptSteps(transcriptPath);
  const brainDir = transcriptPath.includes(`${path.sep}.system_generated${path.sep}`)
    ? path.resolve(transcriptPath, '..', '..', '..')
    : path.dirname(transcriptPath);

  let firstPrompt = '';
  let lastUserIdx = -1;
  let lastReplyStep = null;
  const recentTools = [];
  const messages = [];
  let pendingToolRun = null;

  const flushPendingToolRun = () => {
    if (!pendingToolRun) return;
    messages.push({
      id: pendingToolRun.id,
      role: 'tool_group',
      text: pendingToolRun.tools.slice(0, 12).map((t) => `[${t}]`).join(' '),
      timestampMs: pendingToolRun.timestampMs,
      stepCount: pendingToolRun.stepCount,
      tools: pendingToolRun.tools,
      toolDetails: pendingToolRun.toolDetails,
    });
    pendingToolRun = null;
  };

  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const tsMs = parseTimestampMs(s.created_at) || Math.round(st.mtimeMs);
    if (s.type === 'USER_INPUT') {
      const cleaned = cleanUserRequest(s.content || '');
      if (cleaned && !firstPrompt) firstPrompt = cleaned;
      lastUserIdx = i;
      if (includeMessages && cleaned) {
        flushPendingToolRun();
        messages.push({
          id: `u-${s.step_index ?? i}`,
          role: 'user',
          text: cleaned,
          timestampMs: tsMs,
          tools: [],
        });
      }
    } else if (s.type === 'PLANNER_RESPONSE') {
      const content = typeof s.content === 'string' ? s.content.trim() : '';
      const toolCalls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      const toolNames = toolCalls.map((t) => t?.name).filter(Boolean);
      for (const name of toolNames) recentTools.push(name);
      if (content && toolCalls.length === 0) {
        lastReplyStep = s;
      } else if (content && !lastReplyStep) {
        lastReplyStep = s;
      }
      if (includeMessages && (content || toolNames.length > 0)) {
        const questionCall = toolCalls.find((tc) => QUESTION_TOOLS.has(tc?.name));
        const parsedQuestions = questionCall ? parseAskQuestionToolArgs(parseToolCallArgsObj(questionCall)) : null;
        if (parsedQuestions) {
          flushPendingToolRun();
          const combined = [content, formatQuestionSummaryMarkdown(parsedQuestions)].filter(Boolean).join('\n\n');
          messages.push({
            id: `a-${s.step_index ?? i}`,
            role: 'assistant',
            text: combined,
            timestampMs: tsMs,
            tools: toolNames,
          });
        } else if (!content && toolNames.length > 0) {
          if (!pendingToolRun) {
            pendingToolRun = {
              id: `a-${s.step_index ?? i}`,
              timestampMs: tsMs,
              stepCount: 0,
              tools: [],
              toolDetails: [],
            };
          }
          pendingToolRun.stepCount += 1;
          for (const tc of toolCalls) {
            if (!tc?.name) continue;
            pendingToolRun.tools.push(tc.name);
            if (pendingToolRun.toolDetails.length < 25) {
              const brief = formatToolCallBrief(tc);
              if (brief) pendingToolRun.toolDetails.push(brief);
            }
          }
        } else {
          flushPendingToolRun();
          messages.push({
            id: `a-${s.step_index ?? i}`,
            role: 'assistant',
            text: content,
            timestampMs: tsMs,
            tools: toolNames,
          });
        }
      }
    } else if (s.type === 'GENERIC') {
      if (includeMessages) {
        const answerText = extractAnswerLinesFromGeneric(s.content || '');
        if (answerText) {
          flushPendingToolRun();
          messages.push({
            id: `u-ans-${s.step_index ?? i}`,
            role: 'user',
            text: answerText,
            timestampMs: tsMs,
            tools: [],
          });
        }
      }
    } else if (s.type === 'ERROR_MESSAGE' || (s.type === 'PLANNER_RESPONSE' && s.status === 'ERROR')) {
      const errText = (s.error || s.content || '').toString().trim();
      if (includeMessages && errText) {
        flushPendingToolRun();
        messages.push({
          id: `e-${s.step_index ?? i}`,
          role: 'system_error',
          text: errText,
          timestampMs: tsMs,
          tools: [],
        });
      }
    }
  }
  if (includeMessages) {
    flushPendingToolRun();
  }

  const lastUserStep = lastUserIdx >= 0 ? steps[lastUserIdx] : null;
  const lastPrompt = lastUserStep ? cleanUserRequest(lastUserStep.content || '') : firstPrompt;
  const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;

  let turnToolCallCount = 0;
  let turnMutatedCount = 0;
  let lastFinalReplyAfterUser = null;
  let lastCurrentTurnProse = '';
  let awaitingQuestionTool = false;
  let latestPendingQuestion = null;
  let askStepIdx = -1;
  let lastErrorAfterUser = null;

  const turnStartIdx = lastUserIdx >= 0 ? lastUserIdx : 0;
  for (let i = turnStartIdx; i < steps.length; i += 1) {
    const s = steps[i];
    if (s.type === 'PLANNER_RESPONSE') {
      const toolCalls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      const hasContent = typeof s.content === 'string' && s.content.trim().length > 0;
      if (hasContent && i > lastUserIdx) {
        lastCurrentTurnProse = s.content.trim();
      }
      let stepHasQuestionTool = false;
      for (const tc of toolCalls) {
        if (!tc || typeof tc.name !== 'string') continue;
        turnToolCallCount += 1;
        if (MUTATING_TOOLS.has(tc.name)) turnMutatedCount += 1;
        if (QUESTION_TOOLS.has(tc.name)) {
          awaitingQuestionTool = true;
          stepHasQuestionTool = true;
          const parsedQ = parseAskQuestionToolArgs(parseToolCallArgsObj(tc));
          if (parsedQ) {
            latestPendingQuestion = {
              id: `ask-${s.step_index ?? i}`,
              source: 'transcript',
              message: hasContent ? s.content.trim() : null,
              questions: parsedQ,
            };
          }
          askStepIdx = i;
        }
      }
      if (!stepHasQuestionTool && i > askStepIdx) {
        awaitingQuestionTool = false;
        latestPendingQuestion = null;
      }
      if (hasContent && toolCalls.length === 0) {
        lastFinalReplyAfterUser = s;
        awaitingQuestionTool = false;
        latestPendingQuestion = null;
      }
    } else if (s.type === 'GENERIC' && askStepIdx >= 0 && i > askStepIdx) {
      awaitingQuestionTool = false;
      latestPendingQuestion = null;
    }
    if (s.type === 'ERROR_MESSAGE' || (s.type === 'PLANNER_RESPONSE' && s.status === 'ERROR')) {
      lastErrorAfterUser = s;
    }
  }

  const turnStartedAtMs = parseTimestampMs(lastUserStep?.created_at) || parseTimestampMs(steps[0]?.created_at) || st.mtimeMs;
  const lastStepMs = parseTimestampMs(lastStep?.created_at) || st.mtimeMs;
  const liveActivityMs = Math.max(Math.round(st.mtimeMs), lastStepMs, dbMeta?.lastModifiedMs || 0);
  const userPromptMs = parseTimestampMs(lastUserStep?.created_at);
  const firstStepMs = parseTimestampMs(steps[0]?.created_at);
  const acpTurnStartMs = acpState?.inFlight ? (acpState.startedAtMs || 0) : 0;
  const finalReplyMs = parseTimestampMs(lastFinalReplyAfterUser?.created_at);
  const errorStepMs = Math.max(
    parseTimestampMs(lastErrorAfterUser?.created_at),
    (acpState?.lastFailure && !lastFinalReplyAfterUser) ? (acpState.lastFailure.atMs || 0) : 0,
  );
  const updatedAtMs = Math.max(userPromptMs, firstStepMs, acpTurnStartMs, finalReplyMs, errorStepMs)
    || lastStepMs
    || Math.round(st.mtimeMs);
  const ageSec = Math.max(0, Math.round((nowMs - liveActivityMs) / 1000));
  const recentStepAgeMs = Math.max(0, nowMs - lastStepMs);
  const turnDurationSec = Math.max(0, Math.round((lastStepMs - turnStartedAtMs) / 1000));

  const activeTools = (
    lastStep &&
    lastStep.type === 'PLANNER_RESPONSE' &&
    Array.isArray(lastStep.tool_calls) &&
    lastStep.tool_calls.length > 0
  )
    ? lastStep.tool_calls.map((t) => t?.name).filter(Boolean)
    : [];

  const isCompactionOrToolOutput = lastStep?.type === 'CHECKPOINT' || lastStep?.type === 'GENERIC';
  const isDesktopActivelyRunning = !dbMeta?.killed && (
    ((dbMeta?.dbStatus === 'CASCADE_RUN_STATUS_RUNNING' || dbMeta?.notFullyIdle) && ageSec < 1800) ||
    (lastStep?.status === 'RUNNING' && ageSec < 600) ||
    (lastUserIdx >= 0 && !lastFinalReplyAfterUser && (
      recentStepAgeMs < 60_000 ||
      (isCompactionOrToolOutput && recentStepAgeMs < 300_000)
    ))
  );

  const hasFatalStepError = Boolean(
    lastStep && (lastStep.type === 'ERROR_MESSAGE' || (lastStep.type === 'PLANNER_RESPONSE' && lastStep.status === 'ERROR')),
  );

  const artifacts = listBrainArtifacts(brainDir, signArtifactPath);
  const acpPendingQuestion = parseAcpElicitationToPendingQuestion(acpState?.pendingElicitation);
  const pendingQuestion = acpPendingQuestion
    || ((latestPendingQuestion && !lastFinalReplyAfterUser && !dbMeta?.killed) ? latestPendingQuestion : null);
  const pendingPermissionSummary = acpState?.pendingPermission
    ? {
      title: String(acpState.pendingPermission.params?.toolCall?.title || acpState.pendingPermission.params?.toolCall?.kind || 'Tool execution'),
      options: (Array.isArray(acpState.pendingPermission.params?.options) ? acpState.pendingPermission.params.options : [])
        .map((o) => String(o?.name || ''))
        .filter(Boolean),
    }
    : null;
  const pendingFeedbackArtifact = findPendingFeedbackArtifact(brainDir, artifacts, turnStartedAtMs);

  let status = 'done';
  if (
    hasFatalStepError ||
    (acpState?.lastFailure && acpState.lastFailure.atMs >= turnStartedAtMs && !lastFinalReplyAfterUser)
  ) {
    status = 'error';
  } else if (
    (acpState?.status === 'question') ||
    (pendingQuestion !== null && ageSec < 86_400) ||
    (awaitingQuestionTool && !lastFinalReplyAfterUser && !dbMeta?.killed && ageSec < 86_400)
  ) {
    status = 'question';
  } else if (
    acpState?.inFlight ||
    (!lastFinalReplyAfterUser && isDesktopActivelyRunning)
  ) {
    status = 'running';
  } else if (lastUserIdx >= 0 && !lastFinalReplyAfterUser) {
    status = 'interrupted';
  }

  let origin = surface === 'cli' ? 'mobile_acp' : 'desktop';
  let handedOffTo = null;
  let handoffSource = null;

  if (handoff?.byMobile) {
    origin = 'mobile_handoff';
    handoffSource = {
      desktopId: handoff.byMobile.sourceDesktopId,
      shortId: handoff.byMobile.sourceShortId,
      title: handoff.byMobile.title || '',
    };
  } else if (handoff?.byDesktop) {
    status = 'handed_off';
    handedOffTo = handoff.byDesktop.mobileSessionId;
  }

  if (status === 'done' && pendingFeedbackArtifact && lastUserIdx >= 0 && !handoff?.byDesktop) {
    status = 'question';
  }

  const workspacePath = decodeWorkspacePath(
    dbMeta?.workspacePath || handoff?.byMobile?.workspacePath || '',
  );
  const workspaceName = workspacePath ? (path.basename(workspacePath) || workspacePath) : '';
  const workspaceDisplayPath = workspacePath ? formatDisplayPath(workspacePath, homeDir) : '';
  const workspaceId = workspacePath ? makeWorkspaceId(workspacePath) : '';

  const replyRaw = (lastFinalReplyAfterUser?.content || '').trim();
  const errorRaw = (lastErrorAfterUser?.error || lastErrorAfterUser?.content || '').toString().trim();

  const title = (dbMeta?.title || '').trim()
    || (handoff?.byMobile?.title || '').trim()
    || (firstPrompt ? firstPrompt.slice(0, 72) : '')
    || conversationId.slice(0, 8);

  let summarySource = '';
  if (status === 'question') {
    if (pendingPermissionSummary?.title) {
      summarySource = `待授权：${pendingPermissionSummary.title}`;
    } else if (pendingQuestion?.questions?.[0]?.question) {
      summarySource = `待确认：${pendingQuestion.questions[0].question}`;
    } else if (pendingFeedbackArtifact?.summary || pendingFeedbackArtifact?.name) {
      summarySource = pendingFeedbackArtifact.summary || `待确认：${pendingFeedbackArtifact.name}`;
    }
  }
  if (!summarySource) {
    if (acpState?.inFlight && acpState.partialAssistantText) {
      summarySource = acpState.partialAssistantText;
    } else if (lastFinalReplyAfterUser) {
      summarySource = lastFinalReplyAfterUser.content;
    } else if (lastUserIdx >= 0) {
      if (status === 'error') {
        summarySource = errorRaw || acpState?.lastFailure?.stderrTail || lastPrompt || title;
      } else {
        summarySource = lastCurrentTurnProse || lastPrompt || title;
      }
    } else {
      summarySource = lastReplyStep?.content || firstPrompt || title;
    }
  }
  const summary = formatReadableExcerpt(summarySource, 220);

  const stepCurrent = turnToolCallCount;
  const stepTotal = 0;
  const activeTool = (acpState?.inFlight && acpState.activeTool)
    ? acpState.activeTool
    : (status === 'running' ? (activeTools[0] || '') : '');

  const base = {
    id: conversationId,
    shortId: conversationId.slice(0, 8),
    surface,
    origin,
    status,
    title,
    summary,
    firstPrompt: firstPrompt.slice(0, 200),
    lastPrompt: lastPrompt.slice(0, 200),
    workspaceId,
    workspacePath,
    workspaceName,
    workspaceDisplayPath,
    stepCurrent,
    stepTotal,
    toolCallCount: turnToolCallCount,
    mutatedCount: turnMutatedCount,
    activeTool,
    recentTools: recentTools.slice(-6),
    updatedAtMs,
    turnDurationSec,
    handedOffTo,
    handoffSource,
    artifacts,
    pendingQuestion,
    pendingPermissionSummary,
    pendingFeedbackArtifact,
  };

  if (includeMessages) {
    base.messages = messages;
    base.lastReplyRaw = replyRaw || (lastReplyStep?.content || '').trim();
    let livePartial = acpState?.inFlight ? (acpState.partialAssistantText || '') : '';
    let liveInFlight = Boolean(acpState?.inFlight);
    if (!liveInFlight && surface === 'desktop' && status === 'running') {
      const desktopPartial = readLiveDesktopStreamingStep(brainDir, conversationId);
      if (desktopPartial) {
        liveInFlight = true;
        livePartial = desktopPartial;
      }
    }
    base.inFlight = liveInFlight;
    base.partialAssistantText = livePartial;
  }
  return base;
}

/**
 * Collect all sessions and workspaces across desktop + CLI transcripts, SQLite DB, and handoffs.
 */
export function collectOverview({
  homeDir = os.homedir(),
  brainRoots,
  dbPaths,
  handoffs = { byDesktopId: {}, byMobileId: {} },
  acpStates = {},
  signArtifactPath = null,
  limit = 60,
  nowMs = Date.now(),
} = {}) {
  const defaults = getDefaultGeminiDirs(homeDir);
  const resolvedRoots = brainRoots || defaults.brainRoots;
  const resolvedDbs = dbPaths || defaults.dbPaths;
  const dbMetaMap = readConversationDbMetadata(resolvedDbs);

  const foundFiles = new Map();
  for (const root of resolvedRoots) {
    if (!root?.dir || !fs.existsSync(root.dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'tempmediaStorage') continue;
      const id = ent.name;
      const meta = dbMetaMap.get(id);
      if (meta && (meta.nestingDepth > 0 || meta.parentConversationId)) {
        continue;
      }
      const transcriptPath = path.join(root.dir, id, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const st = fs.statSync(transcriptPath);
        if (!st.isFile() || st.size === 0) continue;
        const prev = foundFiles.get(id);
        if (!prev || st.mtimeMs > prev.mtimeMs) {
          foundFiles.set(id, {
            id,
            surface: root.surface,
            transcriptPath,
            mtimeMs: st.mtimeMs,
          });
        }
      } catch {}
    }
  }

  const allCandidates = Array.from(foundFiles.values());
  allCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sliced = limit > 0 ? allCandidates.slice(0, limit) : allCandidates;

  const sessions = [];
  const seenIds = new Set();

  for (const item of sliced) {
    try {
      const parsed = parseTranscriptConversation(item.transcriptPath, {
        conversationId: item.id,
        surface: item.surface,
        dbMeta: dbMetaMap.get(item.id) || null,
        handoff: {
          byDesktop: handoffs.byDesktopId?.[item.id] || null,
          byMobile: handoffs.byMobileId?.[item.id] || null,
        },
        acpState: acpStates?.[item.id] || null,
        homeDir,
        signArtifactPath,
        nowMs,
        includeMessages: false,
      });
      sessions.push(parsed);
      seenIds.add(item.id);
    } catch {}
  }

  // Synthesize mobile_handoff sessions that were just created via ACP and don't have a transcript.jsonl turn yet
  for (const [mobileId, rec] of Object.entries(handoffs.byMobileId || {})) {
    if (seenIds.has(mobileId)) continue;
    const wsPath = decodeWorkspacePath(rec.workspacePath || '');
    sessions.push({
      id: mobileId,
      shortId: mobileId.slice(0, 8),
      surface: 'cli',
      origin: 'mobile_handoff',
      status: 'done',
      title: rec.title || `Handoff #${rec.sourceShortId || mobileId.slice(0, 6)}`,
      summary: rec.seedSummary || '',
      firstPrompt: rec.lastPrompt || '',
      lastPrompt: rec.lastPrompt || '',
      workspaceId: wsPath ? makeWorkspaceId(wsPath) : '',
      workspacePath: wsPath,
      workspaceName: wsPath ? (path.basename(wsPath) || wsPath) : '',
      workspaceDisplayPath: wsPath ? formatDisplayPath(wsPath, homeDir) : '',
      stepCurrent: 0,
      stepTotal: 0,
      toolCallCount: 0,
      mutatedCount: 0,
      activeTool: '',
      recentTools: [],
      updatedAtMs: rec.handedOffAtMs || nowMs,
      turnDurationSec: 0,
      handedOffTo: null,
      handoffSource: {
        desktopId: rec.sourceDesktopId,
        shortId: rec.sourceShortId,
        title: rec.title || '',
      },
      artifacts: [],
    });
  }

  sessions.sort((a, b) => ((b.updatedAtMs || 0) - (a.updatedAtMs || 0)) || a.id.localeCompare(b.id));

  const workspaces = buildWorkspaceSummaries(sessions, {
    homeDir,
    extraPaths: [
      path.join(homeDir, 'Repos'),
      path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Agent'),
    ],
  });

  return {
    sessions,
    workspaces,
    totalCount: allCandidates.length,
  };
}

/**
 * Load full detail (transcript messages + artifacts + source desktop context if handed off) for one session.
 */
export function getSessionDetail(sessionId, {
  homeDir = os.homedir(),
  brainRoots,
  dbPaths,
  handoffs = { byDesktopId: {}, byMobileId: {} },
  acpStates = {},
  signArtifactPath = null,
  nowMs = Date.now(),
} = {}) {
  const defaults = getDefaultGeminiDirs(homeDir);
  const resolvedRoots = brainRoots || defaults.brainRoots;
  const resolvedDbs = dbPaths || defaults.dbPaths;
  const dbMetaMap = readConversationDbMetadata(resolvedDbs);

  const findTranscript = (id) => {
    for (const root of resolvedRoots) {
      if (!root?.dir) continue;
      const p = path.join(root.dir, id, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(p)) {
        return { surface: root.surface, transcriptPath: p };
      }
    }
    return null;
  };

  const found = findTranscript(sessionId);
  if (found) {
    const detail = parseTranscriptConversation(found.transcriptPath, {
      conversationId: sessionId,
      surface: found.surface,
      dbMeta: dbMetaMap.get(sessionId) || null,
      handoff: {
        byDesktop: handoffs.byDesktopId?.[sessionId] || null,
        byMobile: handoffs.byMobileId?.[sessionId] || null,
      },
      acpState: acpStates?.[sessionId] || null,
      homeDir,
      signArtifactPath,
      nowMs,
      includeMessages: true,
    });

    const handoffRec = handoffs.byMobileId?.[sessionId];
    if (handoffRec?.sourceDesktopId) {
      const src = findTranscript(handoffRec.sourceDesktopId);
      if (src) {
        try {
          const srcDetail = parseTranscriptConversation(src.transcriptPath, {
            conversationId: handoffRec.sourceDesktopId,
            surface: src.surface,
            dbMeta: dbMetaMap.get(handoffRec.sourceDesktopId) || null,
            homeDir,
            signArtifactPath,
            nowMs,
            includeMessages: true,
          });
          detail.sourceMessages = (srcDetail.messages || []).slice(-6);
          if (detail.artifacts.length === 0 && srcDetail.artifacts.length > 0) {
            detail.artifacts = srcDetail.artifacts;
          }
        } catch {}
      }
    }
    return detail;
  }

  const handoffRec = handoffs.byMobileId?.[sessionId];
  if (handoffRec) {
    const wsPath = decodeWorkspacePath(handoffRec.workspacePath || '');
    let sourceMessages = [];
    let sourceArtifacts = [];
    if (handoffRec.sourceDesktopId) {
      const src = findTranscript(handoffRec.sourceDesktopId);
      if (src) {
        try {
          const srcDetail = parseTranscriptConversation(src.transcriptPath, {
            conversationId: handoffRec.sourceDesktopId,
            surface: src.surface,
            dbMeta: dbMetaMap.get(handoffRec.sourceDesktopId) || null,
            homeDir,
            signArtifactPath,
            nowMs,
            includeMessages: true,
          });
          sourceMessages = (srcDetail.messages || []).slice(-6);
          sourceArtifacts = srcDetail.artifacts || [];
        } catch {}
      }
    }
    return {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      surface: 'cli',
      origin: 'mobile_handoff',
      status: acpStates?.[sessionId]?.inFlight ? (acpStates[sessionId].status || 'running') : 'done',
      title: handoffRec.title || `Handoff #${handoffRec.sourceShortId}`,
      summary: (acpStates?.[sessionId]?.inFlight && acpStates[sessionId].partialAssistantText)
        ? formatReadableExcerpt(acpStates[sessionId].partialAssistantText, 220)
        : (handoffRec.seedSummary || ''),
      firstPrompt: handoffRec.lastPrompt || '',
      lastPrompt: handoffRec.lastPrompt || '',
      workspaceId: wsPath ? makeWorkspaceId(wsPath) : '',
      workspacePath: wsPath,
      workspaceName: wsPath ? (path.basename(wsPath) || wsPath) : '',
      workspaceDisplayPath: wsPath ? formatDisplayPath(wsPath, homeDir) : '',
      stepCurrent: acpStates?.[sessionId]?.inFlight ? 1 : 0,
      stepTotal: 0,
      toolCallCount: 0,
      mutatedCount: 0,
      activeTool: acpStates?.[sessionId]?.activeTool || '',
      recentTools: [],
      updatedAtMs: Math.max(handoffRec.handedOffAtMs || nowMs, acpStates?.[sessionId]?.updatedAtMs || 0),
      turnDurationSec: 0,
      handedOffTo: null,
      handoffSource: {
        desktopId: handoffRec.sourceDesktopId,
        shortId: handoffRec.sourceShortId,
        title: handoffRec.title || '',
      },
      artifacts: sourceArtifacts,
      messages: [],
      sourceMessages,
      inFlight: Boolean(acpStates?.[sessionId]?.inFlight),
      partialAssistantText: acpStates?.[sessionId]?.inFlight ? (acpStates[sessionId].partialAssistantText || '') : '',
    };
  }

  return null;
}

/**
 * Watch configured brain roots and invoke `onChange` (debounced) when transcripts update.
 */
export function watchBrainRoots(brainRoots, onChange, { debounceMs = 1000 } = {}) {
  const effectiveDebounceMs = Math.max(debounceMs, 1000);
  const watchers = [];
  const watchedDirs = new Set();
  let timer = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try { onChange(); } catch {}
    }, effectiveDebounceMs);
  };

  const addWatchDir = (dirPath, matchFn) => {
    if (!dirPath || watchedDirs.has(dirPath) || !fs.existsSync(dirPath)) return;
    watchedDirs.add(dirPath);
    try {
      const w = fs.watch(dirPath, { recursive: true }, (_eventType, filename) => {
        if (!filename || matchFn(String(filename))) {
          trigger();
        }
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      try {
        const w = fs.watch(dirPath, () => trigger());
        w.on('error', () => {});
        watchers.push(w);
      } catch {}
    }
  };

  for (const root of brainRoots) {
    if (!root?.dir) continue;
    addWatchDir(root.dir, (fn) => fn.endsWith('.jsonl') || fn.endsWith('.metadata.json') || !fn.includes('.'));
    const convDir = path.join(path.dirname(root.dir), 'conversations');
    addWatchDir(convDir, (fn) => fn.endsWith('.db') || fn.endsWith('.db-wal'));
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
}
