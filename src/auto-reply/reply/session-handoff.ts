/**
 * Session Handoff — generates a structured handoff summary when a session resets,
 * allowing the new session to pick up context from the previous one.
 *
 * On /new or /reset, reads recent messages from the ending session transcript
 * and writes a SESSION_HANDOFF.md file in the workspace. This file is automatically
 * loaded as a context file in the new session's system prompt.
 */
import fs from "node:fs";
import path from "node:path";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionFilePath } from "../../config/sessions/paths.js";
import { logVerbose } from "../../globals.js";

/** Maximum number of recent messages to include in the handoff */
const HANDOFF_MAX_MESSAGES = 40;
/** Maximum characters per message to include */
const HANDOFF_MAX_CHARS_PER_MESSAGE = 2000;
/** Maximum total size of the handoff file (chars) */
const HANDOFF_MAX_TOTAL_CHARS = 30_000;

type TranscriptMessage = {
  role?: string;
  content?: unknown;
  model?: string;
  timestamp?: number;
};

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        // Summarize tool calls briefly
        const inputStr = b.input ? JSON.stringify(b.input).slice(0, 200) : "";
        textParts.push(`[tool: ${b.name}${inputStr ? ` ${inputStr}...` : ""}]`);
      } else if (b.type === "tool_result") {
        // Skip tool results in handoff (too verbose)
      }
    }
    return textParts.join("\n");
  }
  return "";
}

function readRecentMessages(
  sessionFile: string,
  maxMessages: number,
): TranscriptMessage[] {
  if (!fs.existsSync(sessionFile)) {
    return [];
  }

  try {
    const stat = fs.statSync(sessionFile);
    const readBytes = Math.min(stat.size, 512_000); // Read last 500KB
    const fd = fs.openSync(sessionFile, "r");
    try {
      const readStart = Math.max(0, stat.size - readBytes);
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, readStart);
      const chunk = buf.toString("utf-8");
      const lines = chunk.split(/\r?\n/).filter((l) => l.trim());

      const messages: TranscriptMessage[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const msg = parsed?.message as TranscriptMessage | undefined;
          if (msg && typeof msg === "object" && (msg.role === "user" || msg.role === "assistant")) {
            messages.push(msg);
          }
        } catch {
          // skip malformed
        }
      }

      // Return last N messages
      return messages.slice(-maxMessages);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    logVerbose(`session-handoff: failed to read transcript: ${err}`);
    return [];
  }
}

function formatTimestamp(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  } catch {
    return "";
  }
}

export async function generateSessionHandoff(params: {
  previousEntry: SessionEntry;
  workspaceDir: string;
  agentId?: string;
  sessionsDir?: string;
}): Promise<{ written: boolean; path?: string }> {
  const { previousEntry, workspaceDir } = params;

  if (!previousEntry.sessionId) {
    return { written: false };
  }

  // Resolve the session file path
  let sessionFile: string | undefined;
  try {
    sessionFile = previousEntry.sessionFile;
    if (!sessionFile) {
      sessionFile = resolveSessionFilePath(previousEntry.sessionId, previousEntry, {
        agentId: params.agentId,
        sessionsDir: params.sessionsDir,
      });
    }
  } catch {
    logVerbose("session-handoff: could not resolve session file path");
    return { written: false };
  }

  if (!sessionFile || !fs.existsSync(sessionFile)) {
    logVerbose(`session-handoff: session file not found: ${sessionFile}`);
    return { written: false };
  }

  const messages = readRecentMessages(sessionFile, HANDOFF_MAX_MESSAGES);
  if (messages.length === 0) {
    logVerbose("session-handoff: no messages in previous session");
    return { written: false };
  }

  // Build handoff document
  const lines: string[] = [];
  lines.push("# Session Handoff");
  lines.push("");
  lines.push("*This is an automatic summary of the previous session, provided for continuity.*");
  lines.push(`*Previous session ended: ${formatTimestamp(previousEntry.updatedAt)}*`);
  if (previousEntry.totalTokens) {
    lines.push(`*Previous session tokens used: ~${previousEntry.totalTokens.toLocaleString()}*`);
  }
  lines.push("");
  lines.push("## Recent Conversation");
  lines.push("");

  let totalChars = lines.join("\n").length;

  for (const msg of messages) {
    const text = extractTextFromContent(msg.content);
    if (!text.trim()) continue;

    const truncated = text.length > HANDOFF_MAX_CHARS_PER_MESSAGE
      ? text.slice(0, HANDOFF_MAX_CHARS_PER_MESSAGE) + "... [truncated]"
      : text;

    const role = msg.role === "user" ? "**User**" : "**Assistant**";
    const ts = formatTimestamp(msg.timestamp);
    const entry = `${role}${ts ? ` (${ts})` : ""}:\n${truncated}\n`;

    if (totalChars + entry.length > HANDOFF_MAX_TOTAL_CHARS) {
      lines.push("*[Earlier messages truncated for space]*\n");
      break;
    }

    lines.push(entry);
    totalChars += entry.length;
  }

  const handoffContent = lines.join("\n");
  const handoffPath = path.join(workspaceDir, "SESSION_HANDOFF.md");

  try {
    await fs.promises.writeFile(handoffPath, handoffContent, "utf-8");
    logVerbose(`session-handoff: wrote ${handoffContent.length} chars to ${handoffPath}`);
    return { written: true, path: handoffPath };
  } catch (err) {
    logVerbose(`session-handoff: failed to write handoff file: ${err}`);
    return { written: false };
  }
}

/**
 * Remove the handoff file after the new session has started (optional cleanup).
 * Called after the agent has had a chance to read it.
 */
export function cleanupSessionHandoff(workspaceDir: string): void {
  const handoffPath = path.join(workspaceDir, "SESSION_HANDOFF.md");
  try {
    if (fs.existsSync(handoffPath)) {
      fs.unlinkSync(handoffPath);
    }
  } catch {
    // Ignore cleanup failures
  }
}
