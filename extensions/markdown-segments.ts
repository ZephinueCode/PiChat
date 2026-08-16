export interface MarkdownSegment {
  kind: "chat" | "code";
  text: string;
}

/** Split fenced code from conversational prose without changing model/session content. */
export function splitMarkdownSegments(source: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const prose: string[] = [];
  const code: string[] = [];
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;

  const flush = (kind: MarkdownSegment["kind"], lines: string[]) => {
    const text = lines.join("\n").trim();
    if (text) segments.push({ kind, text });
    lines.length = 0;
  };

  for (const line of source.split("\n")) {
    if (!fenceCharacter) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!opening) {
        prose.push(line);
        continue;
      }
      flush("chat", prose);
      const marker = opening[1]!;
      fenceCharacter = marker[0] as "`" | "~";
      fenceLength = marker.length;
      code.push(line);
      continue;
    }

    code.push(line);
    const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (
      closing &&
      closing[1]![0] === fenceCharacter &&
      closing[1]!.length >= fenceLength
    ) {
      flush("code", code);
      fenceCharacter = undefined;
      fenceLength = 0;
    }
  }

  if (code.length) flush("code", code);
  flush("chat", prose);
  return segments;
}
