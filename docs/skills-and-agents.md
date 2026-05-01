# Skills and Custom Agents

Skills and agents let you specialize nlpilot for specific projects or workflows without changing source code.

---

## Skills

Skills inject domain-specific instructions into the system prompt. They are similar to GitHub Copilot skills.

### File Layout

```
.nlpilot/
└── skills/
    ├── react/
    │   └── SKILL.md
    └── testing/
        └── SKILL.md
```

### SKILL.md Format

```markdown
---
name: react
description: React component patterns and conventions for this project
---

When writing React components:
- Use functional components with hooks.
- Prefer `useCallback` for event handlers passed to children.
- Write unit tests in `__tests__/<Component>.test.tsx`.
- Use Tailwind CSS for styling; avoid inline styles.
```

- **Frontmatter** (`---`): `name` (optional, defaults to directory name) and `description`.
- **Body**: Free-form markdown instructions. This text is shown to the model when the skill is active.

### Invocation

The model sees a skills index in the system prompt:

```
--- Available skills (invoke via /SKILL-NAME) ---
- react: React component patterns and conventions for this project
- testing: Testing guidelines and helpers
```

The model can invoke a skill by emitting `/react` or `/testing` in its response. The REPL detects these and appends the skill body to the conversation context.

### Auto-Loading

All skills in `.nlpilot/skills/` are loaded automatically at session start. There is no manual enable/disable flag yet.

---

## Custom Agents

Agents are specialized personas that can override the model or restrict tools.

### File Layout

```
.nlpilot/
└── agents/
    ├── reviewer.md
    └── security-auditor.md
```

### Agent Format

```markdown
---
name: security-auditor
description: Focus on security vulnerabilities
tools: view, grep, bash
model: claude-opus-4.7
---

You are a security auditor. For every file change proposed:
1. Check for SQL injection risks.
2. Verify input validation.
3. Look for hardcoded secrets.

Do not suggest stylistic changes.
```

- **`tools`**: Comma-separated list of allowed tools. If omitted, all tools are allowed.
- **`model`**: Override the default model when this agent is active.
- **`description`**: Shown in the system prompt index.

### Future Extensibility

Currently, agents are loaded and listed in the system prompt but not auto-invoked. Planned enhancements:
- `/agent <name>` slash command to switch personas mid-session.
- Auto-delegation based on prompt keywords.

---

## Best Practices

- **Keep skills focused**: One responsibility per skill (e.g., "react", "api-design", "deployment").
- **Avoid overlap**: If two skills give contradictory advice, the model may get confused.
- **Use frontmatter**: The `description` is what the model sees in the index; make it actionable.
- **Size matters**: Very large skill bodies consume context tokens. Aim for under 2,000 characters.
