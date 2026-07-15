/**
 * Turning Claude's written answer into something a TTS voice can read aloud.
 *
 * Extracted from the hook so it can be tested. It's pure string munging, but it's
 * the difference between "the payments module" and "asterisk asterisk the payments
 * module asterisk asterisk", so it's worth getting right.
 */

/**
 * Claude's final message is written to be *read*: headings, bold, bullets, fenced
 * code, links. Fed straight to a TTS voice that becomes unlistenable — a code
 * block in particular turns into a minute of spoken punctuation.
 *
 * This has to happen here rather than in the agent's system prompt: a prompt can
 * stop the model *writing* markdown, but it can't stop it *reading aloud* the
 * markdown we handed it.
 */
export function forSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ') // fenced blocks: unlistenable
    .replace(/`([^`]+)`/g, '$1') // inline code: keep the words, drop the ticks
    .replace(/^#{1,6}\s+/gm, '') // heading markers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/(?<!\*)\*(?!\*)([^*]+)\*/g, '$1') // italics
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links: keep the label, drop the URL
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Keep the tail: the conclusion of a task summary is almost always at the end. */
export function truncateForSpeech(text, maxChars = 4000) {
  if (text.length <= maxChars) return text;
  return '…' + text.slice(-maxChars);
}

/**
 * Is this a message an actual human typed?
 *
 * Load-bearing, and not as obvious as it looks. Claude Code writes TOOL RESULTS into
 * the transcript as `type: "user"` too — because that's what they are, on the wire.
 * So "the last user message" naively includes every Bash result and file read, and a
 * turn's start time collapses to milliseconds ago.
 *
 * A real human message has string content, or content blocks that are text rather
 * than tool_result.
 */
function isHumanMessage(entry) {
  if (entry.type !== 'user') return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === 'text' || typeof b === 'string');
}

/**
 * Pull the task duration and Claude's final prose out of a Claude Code transcript.
 *
 * The transcript is JSONL, one message per line, and it holds the WHOLE SESSION —
 * not the turn that just finished.
 *
 * That distinction was a real bug: duration was measured from the first timestamp in
 * the file, so a task "took" as long as you'd had Claude Code open. Hours. Every task
 * sailed over every threshold, and no threshold ever suppressed anything. `/callme
 * threshold 300` looked broken because it was measuring the wrong thing entirely.
 *
 * So: the turn starts at the LAST human message, not the first line of the file.
 *
 * @returns {{ turnSeconds: number, sessionSeconds: number, lastAssistantText: string|null }}
 */
export function readTranscript(lines) {
  let sessionStart = null;
  let turnStart = null;
  let lastTs = null;
  let lastAssistantText = null;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partial write at the tail of a live transcript; skip it
    }

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : null;
    if (ts && !Number.isNaN(ts)) {
      sessionStart ??= ts;
      lastTs = ts;

      // Each new human message restarts the clock. The last one wins.
      if (isHumanMessage(entry)) turnStart = ts;
    }

    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      // content is a list of blocks. Only the text ones are speech; tool_use
      // blocks are Claude working, not Claude talking.
      const text = entry.message.content
        .filter((block) => block.type === 'text' && block.text?.trim())
        .map((block) => block.text.trim())
        .join('\n\n');
      if (text) lastAssistantText = text;
    }
  }

  const secondsBetween = (a, b) => (a && b ? Math.max(0, Math.round((b - a) / 1000)) : 0);

  return {
    // How long the thing you're being called about actually took.
    turnSeconds: secondsBetween(turnStart ?? sessionStart, lastTs),
    // How long the session has been open. Interesting context, never a threshold.
    sessionSeconds: secondsBetween(sessionStart, lastTs),
    lastAssistantText,
  };
}
