import { splitMarkdownSegments } from "./markdown-segments.ts";

export interface AssistantMessageLike {
  role: string;
  content?: Array<
    | { type: "text"; text: string }
    | { type: string; [key: string]: unknown }
  >;
}

const CODE_LINE = /^(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|[A-Za-z_$][\w$]*\s*=(?!=)|(?:async\s+)?function\b|class\s+[A-Za-z_$][\w$]*(?:\s+extends\s+\S+)?\s*[{:]|interface\s+[A-Za-z_$][\w$]*\s*\{|type\s+[A-Za-z_$][\w$]*\s*=|(?:import|export)\s|from\s+\S+\s+import\s|def\s+\w+\s*\(|(?:if|for|while|switch|catch)\s*\(|(?:console\.\w+|print)\s*\(|#include\b|(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b)/i;
const LOG_LINE = /^(?:\[[^\]]*(?:debug|info|warn|error|trace|fatal)[^\]]*\]|(?:debug|info|warn(?:ing)?|error|trace|fatal)\b|\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2})/i;
const SHELL_LINE = /^(?:\$\s+|PS(?:\s+[^>]+)?>\s+|[A-Za-z]:\\[^>]*>\s+)/;
const DIFF_LINE = /^(?:@@\s|\+\+\+\s|---\s|diff\s+--git\s)/;
const EMOTICON = /(?:[:;=8xX][\-^']?[)(/\\DPp]|[)(/\\DPp][\-^']?[:;=8xX]|\^[_-]?\^|[Tt][_-]?[Tt])/g;

function isNonSpeechLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(?: {4}|\t)/.test(line)) return true;
  if ((trimmed.match(/\|/g)?.length ?? 0) >= 2) return true;
  if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) return true;
  if (CODE_LINE.test(trimmed) || LOG_LINE.test(trimmed) || SHELL_LINE.test(trimmed) || DIFF_LINE.test(trimmed)) return true;
  if (/^(?:at\s+\S+\s+\(|Traceback\s+\(|File\s+"[^"]+",\s+line\s+\d+)/.test(trimmed)) return true;
  if (/^(?:\{|\[)[^\n]*(?:\}|\])\s*[,;]?$/.test(trimmed) && /[:=]/.test(trimmed)) return true;
  return false;
}

/** Reduce Markdown-like assistant prose to text that is safe and useful to speak. */
export function sanitizeSpeechText(source: string): string {
  const prose = splitMarkdownSegments(source)
    .filter((segment) => segment.kind === "chat")
    .map((segment) => segment.text)
    .join("\n");

  const withoutNonSpeechLines = prose
    .split("\n")
    .filter((line) => !isNonSpeechLine(line))
    .join("\n");

  return withoutNonSpeechLines
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/\$[^$\n]+\$/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/gi, " ")
    .replace(/https?:\/\/[^\s，。！？；：、（）《》“”‘’<>]+/gi, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi, " ")
    .replace(/\b[A-Z]:\\(?:[^\\\s,，。!?！？;；:：'"()<>|]+\\)*[^\\\s,，。!?！？;；:：'"()<>|]*/gi, " ")
    .replace(/(^|\s)\/(?:[\w.-]+\/)+[\w.-]+/g, "$1 ")
    .replace(/`{1,3}[^`\n]+`{1,3}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]\n]{1,16}\]/g, " ")
    .replace(EMOTICON, " ")
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, " ")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\u{1F3FB}-\u{1F3FF}\u200D\uFE0E\uFE0F\u20E3]/gu, " ")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]\s+|>+\s*)/gm, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s.,!?;:'"()\-，。！？；：、（）《》“”‘’…—]/gu, " ")
    .replace(/[ \t]+([,.!?;:，。！？；：])/g, "$1")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract only assistant text blocks; thinking, tools, and all other content are ignored. */
export function speechText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as AssistantMessageLike;
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((item): item is { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string")
    .map((item) => sanitizeSpeechText(item.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}
