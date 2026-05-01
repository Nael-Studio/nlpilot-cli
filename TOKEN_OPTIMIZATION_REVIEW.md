# Token Efficiency Review & Improvement Guide

## Executive Summary
Your `nlpilot` codebase has **excellent token management fundamentals** already in place. However, there are several opportunities to optimize further and ensure consistency across all code paths. Below is a comprehensive breakdown of what's working well and what can be improved.

---

## ✅ What's Working Well

### 1. **Message Trimming Strategy** (`src/session.ts`)
**Implementation:** `trimMessagesForSending()` function
- ✅ Keeps the last **3 assistant turns** in full detail
- ✅ Aggressively truncates older tool results (>800 chars → stub)
- ✅ Reduces context bloat without losing recent context

**Example:**
```typescript
[output trimmed — 3452 chars]
```

### 2. **Compact Transcript Generation** (`src/commands/compact.ts`)
**Implementation:** `buildCompactTranscript()` function
- ✅ Truncates tool results to **400 chars** before summarization
- ✅ Prevents the summarizer from re-ingesting massive contexts
- ✅ Preserves conversation flow in compact form

### 3. **Auto-Compact Trigger** (`src/commands/repl.ts`)
**Implementation:** Auto-compact at 180k tokens
```typescript
if (totalTokensUsed > 180_000) {
  await runAutoCompact(session);
}
```
- ✅ Detects context saturation proactively
- ✅ Converts long conversations into summaries

### 4. **Context Efficiency Instructions** (`src/session.ts`)
**System Prompt Guidance:**
```
"CONTEXT EFFICIENCY (important):
- Never read entire files unless they are clearly small. Default to `view` with `startLine`/`endLine`.
- Use `glob` to discover files; do NOT scan whole directories with `view`.
- Use `grep` first to locate symbols/strings, then `view` only the narrow line range.
- Prefer one targeted tool call over many wide ones; do not pre-load files 'just in case'.
- Stop reading once you have enough to act."
```
- ✅ Educates the AI assistant about efficient coding patterns
- ✅ Direct impact on reducing unnecessary reads

---

## 🎯 Improvement Opportunities

### 1. **Per-Tool Output Capping** (HIGH PRIORITY)
**Current Issue:** Tool results aren't capped at the point of generation.
- `bash` outputs can be massive (full file listings, test outputs)
- `view` results are large but sometimes unbounded
- `grep` results accumulate across multiple calls

**Recommendation:**
```typescript
// In src/tools/index.ts or tool wrapper
function capToolOutput(output: unknown, maxChars: number = 2000): unknown {
  const str = typeof output === 'string' ? output : JSON.stringify(output);
  if (str.length > maxChars) {
    return `${str.slice(0, maxChars)}\n[...truncated ${str.length - maxChars} chars]`;
  }
  return output;
}
```

**Apply to:**
- `bash` command output (cap at 2000 chars)
- `view` results (already have line limits, but enforce char limits too)
- `grep` results (warn on >50 matches)

---

### 2. **Token Budget Per Turn** (HIGH PRIORITY)
**Current Issue:** No per-turn token budget enforcement.

**Problem Scenario:**
```
User: "List all files in the project"
  → bash finds 500 files
  → 50k tokens just from one command
  → context already at 70% capacity after one turn
```

**Recommendation:**
```typescript
// Add to Session interface
interface Session {
  // ... existing fields
  maxTokensPerTurn?: number;  // default: 30,000
  lastTurnInputTokens?: number;
  lastTurnOutputTokens?: number;
}

// In repl.ts or oneshot.ts, before streamText()
const usage = await result.totalUsage;
if (usage.inputTokens > session.maxTokensPerTurn) {
  console.warn(`⚠ This turn used ${usage.inputTokens} tokens (>max ${session.maxTokensPerTurn})`);
  // Could trigger auto-compact or warn user
}
```

---

### 3. **Smarter trimMessagesForSending() Tuning** (MEDIUM PRIORITY)
**Current Settings:**
```typescript
keepFullTurns = 3,      // Keep last 3 assistant turns
maxResultChars = 800,   // Trim tool results >800 chars
```

**Analysis:** These are reasonable defaults but could be smarter:

**Issue 1:** `keepFullTurns = 3` is static
- For long conversations, this might be too aggressive
- For short conversations, might be sufficient but not optimal

**Issue 2:** `maxResultChars = 800` is the same everywhere
- A failed bash command (short error) shouldn't be trimmed to 800 chars
- A successful multi-file grep (verbose) should be trimmed more

**Recommendation:**
```typescript
interface TrimConfig {
  keepFullTurns: number;
  maxResultChars: number;
  smartTrim: boolean;  // Enable adaptive trimming
  minCharsBefore: number;  // Don't trim if <200 chars
}

export function trimMessagesForSending(
  messages: ModelMessage[],
  config: Partial<TrimConfig> = {},
): ModelMessage[] {
  const {
    keepFullTurns = 3,
    maxResultChars = 800,
    smartTrim = true,
    minCharsBefore = 200,
  } = config;

  return messages.map((msg, idx) => {
    if (msg.role !== "tool") return msg;
    
    const parts = msg.content as ToolResultPart[];
    return {
      ...msg,
      content: parts.map((part) => {
        const resultStr = typeof part.output === "string" 
          ? part.output 
          : JSON.stringify(part.output);
        
        // Don't trim small results
        if (resultStr.length < minCharsBefore) return part;
        
        // Smart trim: adjust based on tool type
        let cap = maxResultChars;
        if (smartTrim) {
          // Error messages: keep more (errors are usually short)
          if (resultStr.includes("Error") || resultStr.includes("error")) {
            cap = Math.max(cap, 1500);
          }
          // Success with truncation warnings: keep as-is
          if (resultStr.includes("...")) {
            return part; // Already truncated by tool
          }
        }
        
        if (resultStr.length > cap) {
          return {
            ...part,
            output: { 
              type: "text" as const, 
              value: `${resultStr.slice(0, cap)}\n[output trimmed — ${resultStr.length - cap} chars]` 
            },
          };
        }
        return part;
      }),
    };
  });
}
```

---

### 4. **Context Window Awareness** (MEDIUM PRIORITY)
**Current Issue:** Hard-coded 180k context limit assumption.

```typescript
// src/commands/repl.ts, line ~312
if (totalTokensUsed > 180_000) {
  await runAutoCompact(session);
}
```

**Problem:** Not all models have the same context window:
- `claude-opus`: 200k tokens
- `gpt-4`: 128k tokens
- `gpt-4-turbo`: 128k tokens
- `gemini-2.0-flash`: 1M tokens

**Recommendation:**
```typescript
// In models.ts, add context window to ModelOption
interface ModelOption {
  name: string;
  description: string;
  contextSize: number;  // ← Already exists! ✅
}

// In repl.ts, use it:
const contextWindow = getModelContextWindow(session.modelName, session.creds);
const thresholdTokens = contextWindow * 0.85;  // Trigger at 85%
if (totalTokensUsed > thresholdTokens) {
  await runAutoCompact(session);
}
```

**Check your models.ts** — I see `contextSize` is already in `ModelOption`! So this is **already partially implemented**. Just need to use it consistently.

---

### 5. **Granular Token Tracking** (MEDIUM PRIORITY)
**Current:** Only tracks cumulative input/output tokens.

**Recommendation:** Add per-category tracking:
```typescript
interface TokenMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  
  // Per-category breakdown
  systemPromptTokens: number;
  instructionsTokens: number;
  previousMessagesTokens: number;  // Helpful for understanding trimming impact
  currentTurnInputTokens: number;
  currentTurnOutputTokens: number;
}

// In repl.ts, after each turn:
const sysPrompt = buildSystemPrompt(session);
const systemTokens = estimateTokens([
  { role: "user", content: sysPrompt }
]);

console.log(`System: ${systemTokens} | Turn Input: ${usage.inputTokens} | Turn Output: ${usage.outputTokens}`);
```

Then users can see:
```
System: 1200 | Instr: 0 | Previous: 45000 | Input: 2300 | Output: 1800 → Total: 50,300 / 128,000 (39%)
```

---

### 6. **Instruction File Size Warnings** (LOW PRIORITY)
**Current Issue:** No validation that custom instructions won't bloat context.

**Problem Scenario:**
```
User loads .nlpilot/instructions.md (500kb of custom rules)
  → System prompt jumps from 2k to 502k tokens
  → One file read + one response = 50k tokens used
  → Rapid context window saturation
```

**Recommendation:**
```typescript
// In session.ts, buildSystemPrompt()
const MAX_INSTRUCTIONS_TOKENS = 15000;

const instrBlock =
  session.instructions.files.length > 0
    ? "\\n\\n--- Project instructions ---\\n" +
      session.instructions.files
        .map((f) => {
          const content = f.content;
          const estTokens = Math.ceil(content.length / 4);
          if (estTokens > MAX_INSTRUCTIONS_TOKENS) {
            return `# ${f.path}\n[Instructions file is ${estTokens} tokens - too large, showing summary only]\n${content.slice(0, 5000)}...`;
          }
          return `# ${f.path}\n${content}`;
        })
        .join("\\n\\n")
    : "";
```

---

### 7. **Enforce Tool Step Limits More Aggressively** (LOW PRIORITY)
**Current:**
```typescript
// repl.ts
stopWhen: stepCountIs(6),

// oneshot.ts
stopWhen: stepCountIs(20),
```

**Observation:** 
- 6 steps for REPL is good (allows for multi-step reasoning)
- 20 steps for one-shot is quite high

**Recommendation:**
- Document why these limits exist
- Consider adding config option to tune:
  ```typescript
  interface ReplOptions {
    maxSteps?: number;  // default: 6
  }
  ```
- Track when step limit is hit vs. natural completion

---

### 8. **Smarter Compression Strategies** (MEDIUM PRIORITY)

**Issue:** Current compression is one-size-fits-all (800 chars → stub)

**Better Approach:** Content-aware compression
```typescript
function smartCompress(content: string, toolName: string): string {
  const lines = content.split('\n');
  
  switch (toolName) {
    case 'bash':
      // Keep first error line if present
      const errorLine = lines.find(l => l.includes('Error'));
      if (errorLine) return errorLine;
      // Otherwise keep last line (often the summary)
      return lines[lines.length - 1] || content;
      
    case 'view':
      // Keep first + last 5 lines (header + code snippet)
      if (lines.length > 10) {
        return [
          ...lines.slice(0, 5),
          `... [${lines.length - 10} lines omitted] ...`,
          ...lines.slice(-5)
        ].join('\n');
      }
      return content;
      
    case 'grep':
      // Keep first 10 matches + count
      if (lines.length > 10) {
        return [
          ...lines.slice(0, 10),
          `... [${lines.length - 10} more matches] ...`
        ].join('\n');
      }
      return content;
  }
  
  // Default: just truncate
  if (content.length > 800) {
    return content.slice(0, 800) + '...';
  }
  return content;
}
```

---

### 9. **Add Context Visualization Command** (LOW PRIORITY)
**Idea:** New `/stats` command to show context breakdown

```typescript
// New command in commands/
export async function statsCommand(session: Session): Promise<void> {
  const systemPrompt = buildSystemPrompt(session);
  const sysTokens = estimateTokens([{ role: "user", content: systemPrompt }]);
  const msgTokens = estimateTokens(session.messages);
  const total = sysTokens + msgTokens;
  const contextWindow = getModelContextWindow(session.modelName, session.creds);
  const usage = (total / contextWindow) * 100;
  
  console.log(kleur.bold('Context Usage'));
  console.log(`System prompt: ${sysTokens} tokens`);
  console.log(`Messages: ${msgTokens} tokens (${session.messages.length} messages)`);
  console.log(`Total: ${total} / ${contextWindow} tokens (${usage.toFixed(1)}%)`);
  console.log('');
  console.log('Cumulative usage: ', {
    input: session.cumulativeInputTokens,
    output: session.cumulativeOutputTokens,
  });
}
```

Then add to `/help`:
```
/stats - Show current context usage and breakdown
```

---

## 📋 Action Plan (Prioritized)

### **Phase 1: Critical (Do First)**
1. ✅ Review and document the 180k token limit — make it context-window-aware
2. 🔴 **Add per-tool output capping** (2-4 hour implementation)
3. 🔴 **Implement token budget per turn** (2-3 hour implementation)

### **Phase 2: Important (Next Week)**
4. 🟡 Improve trimMessagesForSending() with smart/adaptive trimming
5. 🟡 Add granular token tracking and display
6. 🟡 Instruction file size validation

### **Phase 3: Nice-to-Have (Polish)**
7. 🟢 Content-aware compression strategies
8. 🟢 Context visualization (`/stats` command)
9. 🟢 Better documentation of token budgets

---

## Code Examples to Implement

### Example 1: Per-Tool Output Capping
```typescript
// src/tools/index.ts

export function buildTools(config: BuildToolsConfig): Record<string, Tool> {
  return {
    bash: tool({
      description: "Execute a shell command",
      parameters: z.object({ command: z.string() }),
      execute: async (input) => {
        const result = await execBash(input.command);
        // Cap the output
        if (result.length > 2000) {
          return `${result.slice(0, 2000)}\n[...output truncated, ${result.length - 2000} chars omitted]`;
        }
        return result;
      },
    }),
    // ... rest of tools
  };
}
```

### Example 2: Token Budget Warning
```typescript
// In repl.ts, after getting usage:

const warningThreshold = 25000;  // Warn at 25k per turn
if (usage.inputTokens > warningThreshold) {
  console.log(
    kleur.yellow(`⚠ Warning: This turn used ${usage.inputTokens} tokens (>suggested max 25k)`)
  );
  console.log(kleur.dim(`   Consider being more specific next time.`));
}
```

---

## Summary Table

| Improvement | Priority | Impact | Effort | Status |
|------------|----------|--------|--------|--------|
| Per-tool output capping | HIGH | ⭐⭐⭐ | Medium | Not implemented |
| Token budget per turn | HIGH | ⭐⭐⭐ | Medium | Not implemented |
| Context-window-aware triggers | MEDIUM | ⭐⭐ | Low | Partially done |
| Smart trimming (adaptive) | MEDIUM | ⭐⭐ | Medium | Not implemented |
| Granular token tracking | MEDIUM | ⭐⭐ | Low | Not implemented |
| Instruction file validation | LOW | ⭐ | Low | Not implemented |
| Content-aware compression | MEDIUM | ⭐⭐ | High | Not implemented |
| Context stats command | LOW | ⭐ | Low | Not implemented |

---

## Key Takeaways

1. **You already have the hard parts right:** Trimming, auto-compact, system prompt guidance ✅
2. **Missing piece:** Per-tool output capping before messages are even recorded
3. **Quick wins:** Add token budget warnings and use existing contextSize data
4. **Long-term:** Implement smarter, content-aware compression strategies

Your foundation is solid. These improvements will push it to **production-grade** token efficiency. 🚀
