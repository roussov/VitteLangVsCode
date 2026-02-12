import * as vscode from "vscode";

type Logger = (message: string) => void;

interface SuggestionState {
  prompt: string;
  output: string;
  history: Array<{ title: string; output: string; ts: number }>;
  aiStatus: string;
}

interface AiConfig {
  enabled: boolean;
  provider: "ollama" | "llamacpp";
  model: string;
  endpoint: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  strictVitteOnly: boolean;
}

function sanitize(input: string): string {
  return input.replace(/[<>]/g, "");
}

function buildSuggestion(promptRaw: string): string {
  const prompt = promptRaw.toLowerCase();
  const templates: Array<{ when: (p: string) => boolean; code: string }> = [
    {
      when: (p) => p.includes("http") || p.includes("rest") || p.includes("request") || p.includes("fetch"),
      code: `proc http_get(url: string) -> string {\n  // TODO: implement HTTP client binding\n  return ""\n}\n\nproc fetch_user(user_id: int) -> string {\n  const url = "https://api.example.com/users/" + user_id as string\n  return http_get(url)\n}`
    },
    {
      when: (p) => p.includes("json") || p.includes("parse"),
      code: `form User {\n  id: int,\n  name: string\n}\n\nproc parse_user(json: string) -> User {\n  // TODO: implement JSON parsing -> User\n  return User { id: 0, name: "" }\n}`
    },
    {
      when: (p) => p.includes("file") || p.includes("read") || p.includes("write"),
      code: `proc read_file(path: string) -> string {\n  // TODO: implement file read binding\n  return ""\n}\n\nproc write_file(path: string, contents: string) {\n  // TODO: implement file write binding\n}`
    },
    {
      when: (p) => p.includes("cli") || p.includes("args") || p.includes("argument"),
      code: `proc parse_args(args: [string]) -> [string] {\n  // TODO: parse CLI args\n  return args\n}\n\nproc main() {\n  // TODO: read argv from runtime\n  let args: [string] = []\n  let parsed = parse_args(args)\n  emit parsed\n}`
    },
    {
      when: (p) => p.includes("list") || p.includes("array") || p.includes("map"),
      code: `proc build_index(keys: [string], values: [int]) -> [int] {\n  // TODO: build a lookup table (parallel arrays)\n  return values\n}\n\nproc find_in_list(values: [int], needle: int) -> int {\n  for v in values {\n    if v == needle { return v }\n  }\n  return -1\n}`
    },
    {
      when: (p) => p.includes("sort") || p.includes("search") || p.includes("algo"),
      code: `proc bubble_sort(values: [int]) -> [int] {\n  let n: int = 0\n  // TODO: compute n from values length\n  loop {\n    // TODO: implement sort\n    break\n  }\n  return values\n}\n\nproc binary_search(values: [int], target: int) -> int {\n  // TODO: implement binary search\n  return -1\n}`
    },
    {
      when: (p) => p.includes("test") || p.includes("assert"),
      code: `proc test_sum() {\n  let values: [int] = [1, 2, 3]\n  let total = sum_list(values)\n  assert(total == 6)\n}\n\nproc sum_list(values: [int]) -> int {\n  let total: int = 0\n  for v in values { set total = total + v }\n  return total\n}`
    },
    {
      when: (p) => p.includes("async") || p.includes("concurrency") || p.includes("parallel"),
      code: `proc spawn_job(name: string) {\n  // TODO: spawn async job\n}\n\nproc main() {\n  spawn_job("job-a")\n  spawn_job("job-b")\n}`
    },
    {
      when: (p) => p.includes("struct") || p.includes("form"),
      code: `form User {\n  id: int,\n  name: string\n}\n\nproc main() {\n  let user = User { id: 1, name: "Alice" }\n  emit user\n}`
    }
  ];

  for (const entry of templates) {
    if (entry.when(prompt)) return entry.code;
  }

  return `proc main() {\n  // TODO: implement ${sanitize(promptRaw) || "logic"}\n}`;
}

function getAiConfig(): AiConfig {
  const cfg = vscode.workspace.getConfiguration("vitte.ai");
  const enabled = cfg.get<boolean>("enabled", false);
  const provider = cfg.get<"ollama" | "llamacpp">("provider", "ollama");
  const model = cfg.get<string>("model", "qwen2.5-coder:0.5b");
  const endpoint = cfg.get<string>("endpoint", provider === "ollama" ? "http://localhost:11434" : "http://localhost:8080");
  const maxTokens = cfg.get<number>("maxTokens", 256);
  const temperature = cfg.get<number>("temperature", 0.2);
  const systemPrompt = cfg.get<string>(
    "systemPrompt",
    "You are a Vitte code generator. Output only valid Vitte code, no explanations, no markdown."
  );
  const strictVitteOnly = cfg.get<boolean>("strictVitteOnly", true);
  return { enabled, provider, model, endpoint, maxTokens, temperature, systemPrompt, strictVitteOnly };
}

async function callOllama(cfg: AiConfig, prompt: string): Promise<string> {
  const res = await fetch(`${cfg.endpoint.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      prompt,
      system: cfg.systemPrompt,
      stream: false,
      options: {
        temperature: cfg.temperature,
        num_predict: cfg.maxTokens
      }
    })
  });
  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { response?: string };
  return data.response?.trim() ?? "";
}

async function callLlamaCpp(cfg: AiConfig, prompt: string): Promise<string> {
  const base = cfg.endpoint.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: cfg.systemPrompt },
        { role: "user", content: prompt }
      ],
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens
    })
  });
  if (!res.ok) {
    throw new Error(`llama.cpp error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function generateWithLocalAi(prompt: string, log?: Logger): Promise<string> {
  const cfg = getAiConfig();
  if (!cfg.enabled) {
    return "// Local AI disabled. Enable vitte.ai.enabled in Settings.";
  }
  log?.(`AI provider=${cfg.provider} model=${cfg.model}`);
  if (cfg.provider === "ollama") {
    const raw = await callOllama(cfg, prompt);
    return cfg.strictVitteOnly ? sanitizeVitteOnly(raw) : raw;
  }
  const raw = await callLlamaCpp(cfg, prompt);
  return cfg.strictVitteOnly ? sanitizeVitteOnly(raw) : raw;
}

function sanitizeVitteOnly(raw: string): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, (block) => {
      return block.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
    })
    .replace(/```/g, "")
    .trim();

  const lines = cleaned.split(/\r?\n/);
  const vitteStarts = ["space", "use", "pull", "share", "type", "form", "trait", "pick", "proc", "macro", "entry", "const", "let", "make"];
  let startIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    if (vitteStarts.some((k) => line.startsWith(k))) {
      startIndex = i;
      break;
    }
  }
  const sliced = lines.slice(startIndex).join("\n").trim();
  return sliced || cleaned;
}

function createGeneratorSession(webview: vscode.Webview, title: string, log?: Logger): void {
  webview.options = { enableScripts: true };
  const state: SuggestionState = {
    prompt: "",
    output: "",
    history: [],
    aiStatus: ""
  };
  const update = () => {
    webview.html = getHtml(state, title);
  };
  update();
  log?.("Webview session initialized.");

  webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "generate") {
      state.prompt = String(msg.prompt ?? "");
      state.output = buildSuggestion(state.prompt);
      if (state.output.trim().length > 0) {
        state.history.unshift({ title: `Template: ${state.prompt || "prompt"}`, output: state.output, ts: Date.now() });
        state.history = state.history.slice(0, 12);
      }
      update();
      return;
    }
    if (msg?.type === "aiGenerate") {
      state.prompt = String(msg.prompt ?? "");
      state.aiStatus = "Generating…";
      update();
      try {
        const result = await generateWithLocalAi(state.prompt, log);
        state.output = result || "// Empty response from local AI.";
        state.history.unshift({ title: `AI: ${state.prompt || "prompt"}`, output: state.output, ts: Date.now() });
        state.history = state.history.slice(0, 12);
        state.aiStatus = "";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.aiStatus = `Error: ${message}`;
        state.output = `// ${message}`;
      }
      update();
      return;
    }
    if (msg?.type === "insert") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage("Open a Vitte/Vit file to insert code.");
        return;
      }
      await editor.edit((edit) => {
        edit.insert(editor.selection.active, state.output + "\n");
      });
      return;
    }
    if (msg?.type === "copy") {
      await vscode.env.clipboard.writeText(state.output);
      void vscode.window.showInformationMessage("Vitte suggestion copied.");
      return;
    }
    if (msg?.type === "clear") {
      state.prompt = "";
      state.output = "";
      state.history = [];
      state.aiStatus = "";
      update();
      return;
    }
    if (msg?.type === "openSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "vitte.ai");
    }
  });
}

export function registerSuggestionsView(
  context: vscode.ExtensionContext,
  viewId = "vitteSuggestions",
  title = "Vitte Offline Suggestions",
  log?: Logger
): void {
  const provider = {
    resolveWebviewView(view: vscode.WebviewView) {
      log?.(`Resolve view: ${viewId}`);
      createGeneratorSession(view.webview, title, log);
    },
  } satisfies vscode.WebviewViewProvider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(viewId, provider)
  );
}

export function openSuggestionsPanel(
  context: vscode.ExtensionContext,
  title = "Vitte Code Generator",
  log?: Logger
): void {
  const panel = vscode.window.createWebviewPanel(
    "vitteCodeGeneratorPanel",
    title,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  log?.("Open generator panel.");
  createGeneratorSession(panel.webview, title, log);
  context.subscriptions.push(panel);
}

function getHtml(state: SuggestionState, title: string): string {
  const prompt = escapeHtml(state.prompt);
  const output = escapeHtml(state.output);
  const status = escapeHtml(state.aiStatus);
  const history = state.history
    .map((entry) => {
      const when = new Date(entry.ts).toLocaleTimeString();
      const entryPrompt = escapeHtml(entry.title || "Prompt");
      const entryOutput = escapeHtml(entry.output || "");
      return `<div class="bubble">\n  <div class="bubble-header">${entryPrompt} <span class="time">${when}</span></div>\n  <pre>${entryOutput}</pre>\n</div>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 12px; }
  h3 { margin: 0 0 8px; }
  textarea, input { width: 100%; box-sizing: border-box; }
  textarea { min-height: 120px; }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  button { flex: 1; padding: 6px 10px; }
  pre { white-space: pre-wrap; background: rgba(127,127,127,0.15); padding: 8px; border-radius: 6px; margin: 0; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
  .chip { font-size: 12px; border: 1px solid rgba(127,127,127,0.4); background: transparent; padding: 4px 8px; border-radius: 999px; }
  .bubble { border: 1px solid rgba(127,127,127,0.35); border-radius: 8px; padding: 8px; margin-top: 8px; }
  .bubble-header { font-weight: 600; margin-bottom: 6px; display: flex; justify-content: space-between; gap: 8px; }
  .time { font-weight: 400; opacity: 0.7; font-size: 11px; }
  .muted { opacity: 0.7; font-size: 12px; }
  .status { margin-top: 6px; font-size: 12px; }
</style>
</head>
<body>
  <h3>${escapeHtml(title)}</h3>
  <div class="muted">Offline generator — Vitte only. No general chat.</div>
  <div class="chip-row">
    <button class="chip" data-preset="API HTTP / REST">API HTTP / REST</button>
    <button class="chip" data-preset="Parsing JSON">Parsing JSON</button>
    <button class="chip" data-preset="Lecture/écriture fichiers">Fichiers</button>
    <button class="chip" data-preset="CLI / args">CLI / args</button>
    <button class="chip" data-preset="Structures de données (list/map)">List / map</button>
    <button class="chip" data-preset="Algo (tri, recherche)">Algo</button>
    <button class="chip" data-preset="Tests / assertions">Tests</button>
    <button class="chip" data-preset="Concurrence / async">Async</button>
  </div>
  <label>Prompt</label>
  <input id="prompt" placeholder="Describe what you want" value="${prompt}" />
  <div class="row">
    <button id="generate">Generate Vitte (Template)</button>
    <button id="ai-generate">Generate Vitte (Local AI)</button>
  </div>
  <div class="row">
    <button id="insert">Insert</button>
    <button id="copy">Copy</button>
    <button id="clear">Clear</button>
  </div>
  <div class="status">${status ? status : ""}</div>
  <div class="row">
    <button id="settings">AI Settings</button>
  </div>
  <label style="margin-top:8px; display:block;">Output</label>
  <pre id="output">${output || "(no suggestion yet)"}</pre>
  <div style="margin-top:10px;">
    <label>History</label>
    ${history || `<div class="muted">(no history yet)</div>`}
  </div>

<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('generate').addEventListener('click', () => {
    const prompt = document.getElementById('prompt').value || '';
    vscode.postMessage({ type: 'generate', prompt });
  });
  document.getElementById('ai-generate').addEventListener('click', () => {
    const prompt = document.getElementById('prompt').value || '';
    vscode.postMessage({ type: 'aiGenerate', prompt });
  });
  document.getElementById('insert').addEventListener('click', () => {
    vscode.postMessage({ type: 'insert' });
  });
  document.getElementById('copy').addEventListener('click', () => {
    vscode.postMessage({ type: 'copy' });
  });
  document.getElementById('clear').addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' });
  });
  document.getElementById('settings').addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-preset') || '';
      const input = document.getElementById('prompt');
      input.value = value;
      vscode.postMessage({ type: 'generate', prompt: value });
    });
  });
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
