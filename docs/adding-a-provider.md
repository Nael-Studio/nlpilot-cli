# Adding a New LLM Provider

nlpilot uses the [Vercel AI SDK](https://sdk.vercel.ai) to abstract LLM providers. Adding a new provider usually requires three small changes.

---

## 1. Add the Provider to the Type System

Open `src/config.ts` and extend the `Provider` union:

```typescript
export type Provider = "openai" | "anthropic" | "google" | "deepseek" | "moonshotai" | "mistral";
```

Add a default model in `getDefaultModels()`:

```typescript
mistral: catalog.mistral?.[0]?.id ?? "mistral-large-latest",
```

Add a label in `src/providers.ts`:

```typescript
export const PROVIDER_LABELS: Record<Provider, string> = {
  // ... existing
  mistral: "Mistral AI",
};
```

---

## 2. Add Model Catalog Entries

Open `src/models.ts` and add entries to `FALLBACK_CATALOG`:

```typescript
mistral: [
  {
    id: "mistral-large-latest",
    label: "mistral-large-latest",
    description: "Flagship · 128K ctx · $2/$6 per M",
    contextSize: 128000,
  },
],
```

If the provider supports many models, you only need the most common ones in the fallback; users can always type a custom model ID during `nlpilot login`.

---

## 3. Wire Up the AI SDK Provider

Open `src/providers.ts` and update `getModel()`:

```typescript
// Add import if the AI SDK has a first-party package
import { createMistral } from "@ai-sdk/mistral";
```

Add provider inference in `inferProvider()`:

```typescript
if (modelName.startsWith("mistral-")) {
  return "mistral";
}
```

Add instantiation logic inside `getModel()`:

```typescript
if (creds.baseUrl) {
  // ... existing custom baseUrl logic
}

// Add before the gateway fallback:
if (creds.provider === "mistral") {
  const client = createMistral({ apiKey: creds.apiKey });
  return client(modelName);
}

// Gateway fallback (if supported by the gateway)
const gateway = createGateway({ apiKey: creds.apiKey });
const qualified = modelName.includes("/")
  ? modelName
  : `${inferProvider(modelName, creds.provider)}/${modelName}`;
return gateway(qualified);
```

If the AI SDK does not have a first-party package for your provider, use `createOpenAI` with a custom `baseURL` (OpenAI-compatible endpoints).

---

## 4. Install the Dependency

```bash
bun add @ai-sdk/mistral
```

---

## 5. Test

```bash
bun run typecheck
bun run src/index.ts login
# Select your new provider, enter an API key, pick a model
bun run src/index.ts -p "Say hello"
```

---

## Notes

- **Context size**: Set an accurate `contextSize` so the compact heuristic works correctly.
- **Gateway routing**: If you rely on `@ai-sdk/gateway`, the provider must be supported by the gateway. Otherwise, instantiate the provider directly as shown above.
- **Custom endpoints**: If the provider supports OpenAI-compatible endpoints (e.g., Groq, Fireworks), you don't need a new provider type — just use `openai` with a custom `baseUrl`.
