import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeSpeechText, speechText } from "../extensions/speech-text.ts";

test("preserves multilingual conversational prose and useful punctuation", () => {
  assert.equal(
    sanitizeSpeechText("**你好，今天怎么样？**\nEnglish words stay, too!"),
    "你好，今天怎么样？\nEnglish words stay, too!",
  );
  assert.equal(
    sanitizeSpeechText("# 一个标题\n> 一句引用，也属于正常文字。"),
    "一个标题\n一句引用，也属于正常文字。",
  );
});

test("removes fenced, inline, indented, and code-like lines", () => {
  const output = sanitizeSpeechText([
    "先说正常内容。",
    "```ts",
    "const fencedSecret = 42;",
    "console.log(fencedSecret);",
    "```",
    "这里有 `npm install private-package`，但不要念命令。",
    "    print('indented code')",
    "const looseCode = dangerousCall();",
    "最后一句正常内容。",
  ].join("\n"));

  assert.match(output, /先说正常内容/);
  assert.match(output, /最后一句正常内容/);
  assert.doesNotMatch(output, /fencedSecret|console|npm install|indented code|looseCode|dangerousCall/);
});

test("removes URLs, paths, logs, tables, math, emoji, and decorative symbols", () => {
  const output = sanitizeSpeechText([
    "可以看一下 https://example.com/private?q=1，也别念 test@example.com 😊❤️ [捂脸]。",
    String.raw`本地文件在 D:\private\secret.wav，不需要念路径。`,
    "[INFO] tool execution started",
    "| name | value |",
    "| --- | --- |",
    "公式 $x = y + 1$ 也跳过。",
    "保留这句中文，以及 ordinary words！★→",
  ].join("\n"));

  assert.match(output, /可以看一下/);
  assert.match(output, /也别念/);
  assert.match(output, /不需要念路径/);
  assert.match(output, /保留这句中文，以及 ordinary words！/);
  assert.doesNotMatch(output, /https|test@example|secret\.wav|tool execution|name|value|x = y|😊|❤|捂脸|★|→/);
});

test("only assistant text content is eligible for speech", () => {
  const output = speechText({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private chain of thought" },
      { type: "toolCall", name: "shell", arguments: { command: "do-not-speak" } },
      { type: "text", text: "只朗读这一句。" },
      { type: "toolResult", text: "secret tool output" },
    ],
  });

  assert.equal(output, "只朗读这一句。");
  assert.equal(speechText({ role: "toolResult", content: [{ type: "text", text: "never" }] }), "");
});

test("returns no speech when content contains only non-speakable material", () => {
  assert.equal(sanitizeSpeechText("```python\nprint('only code')\n```\n😂✨"), "");
});
