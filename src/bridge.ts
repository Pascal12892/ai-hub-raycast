import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Provider = "gemini" | "claude" | "codex";
export type ChatMessage = { role: "user" | "assistant"; text: string };

export const PROVIDERS: Provider[] = ["gemini", "claude", "codex"];
export const LABELS: Record<Provider, string> = { gemini: "Gemini", claude: "Claude", codex: "Codex" };

export const SYSTEM_PROMPT = `Antworte im Caveman-Ultra-Stil und in der Sprache der Nutzerfrage. Standard: 1–2 kurze Sätze oder Fragmente, höchstens 35 Wörter. Überschreite das nur, wenn der Nutzer ausdrücklich Details verlangt oder Korrektheit beziehungsweise Sicherheit mehr Text erfordert. Gib ausschließlich die direkte Antwort, notwendige Fakten, Befehle oder Code aus. Keine Begrüßung, Einleitung, Höflichkeitsfloskeln, Beispiele ohne Nachfrage, Wiederholung, Zusammenfassung oder Abschlussformel. Bewahre Zahlen, Bedingungen und Verneinungen exakt. Verändere keine Dateien und führe keine Befehle aus, außer lesenden Befehlen für angehängte Dateien im Arbeitsordner.`;

const ANSWER_TIMEOUT_MS = 180_000;
const MAX_PROMPT_CHARS = 600_000;

/** Höchstgröße pro Datei und insgesamt. */
export const MAX_FILE_BYTES = 100_000_000;
export const MAX_TOTAL_ATTACHMENT_BYTES = 300_000_000;
/** Kleine Textdateien bis zu dieser Gesamtgröße werden direkt in die Frage eingefügt. Passt auch in das Codex-Kontextfenster. */
export const INLINE_LIMIT_BYTES = 500_000;
/** Mehr Zeit, wenn die CLIs große Dateien selbst lesen. */
const FILE_TIMEOUT_MS = 600_000;

/**
 * Eine angehängte Datei. content ist gesetzt, wenn sie direkt in die Frage eingefügt wird.
 * Sonst liest die CLI sie selbst aus einem Arbeitsordner (Datei-Modus).
 */
export type Attachment = { name: string; path: string; size: number; content?: string };

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function readHead(file: string, bytes = 8000): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Prüft Dateien und entscheidet, wie sie übergeben werden.
 * Kleine Textdateien werden eingefügt (schnell, funktioniert überall).
 * Große Dateien und Binärformate (PDF, Bilder, Office) liest die CLI selbst.
 */
export function readAttachments(paths: string[], inlineLimit = INLINE_LIMIT_BYTES): Attachment[] {
  const result: Attachment[] = [];
  let total = 0;
  for (const file of paths) {
    const name = path.basename(file);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      throw new Error(`${name}: Datei nicht gefunden.`);
    }
    if (stat.isDirectory()) throw new Error(`${name} ist ein Ordner. Bitte einzelne Dateien wählen.`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${name} ist zu groß (${formatSize(stat.size)}, höchstens ${formatSize(MAX_FILE_BYTES)}).`);
    total += stat.size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error(`Anhänge zusammen zu groß (höchstens ${formatSize(MAX_TOTAL_ATTACHMENT_BYTES)}).`);
    result.push({ name, path: file, size: stat.size });
  }
  const textTotal = result.reduce((sum, a) => sum + a.size, 0);
  const allText = result.every((a) => !isBinary(readHead(a.path)));
  // Nur wenn alle Dateien Text sind und zusammen klein bleiben, wird eingefügt. Sonst einheitlich Datei-Modus.
  if (allText && textTotal <= inlineLimit) {
    for (const a of result) a.content = readFileSync(a.path, "utf8");
  }
  return result;
}

export function needsFileAccess(attachments: Attachment[]): boolean {
  return attachments.some((a) => a.content === undefined);
}

export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  if (sample.includes(0)) return true;
  // Bekannte Binärformate am Dateianfang erkennen (PDF, PNG, JPEG, ZIP/Office, GIF).
  const head = sample.subarray(0, 4).toString("latin1");
  return head.startsWith("%PDF") || head.startsWith("\x89PNG") || head.startsWith("\xFF\xD8") || head.startsWith("PK") || head.startsWith("GIF8");
}

/**
 * Baut die Frage mit Anhängen. Eingefügte Dateien stehen als Codeblock in der Frage,
 * große Dateien werden nur benannt und liegen im Arbeitsordner der CLI.
 */
export function withAttachments(question: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return question;
  if (needsFileAccess(attachments)) {
    const list = attachments.map((a) => `- ${a.name} (${formatSize(a.size)})`).join("\n");
    return (
      `${question}\n\nAngehängte Dateien liegen im aktuellen Arbeitsordner:\n${list}\n\n` +
      "Lies sie mit deinen Lese-Werkzeugen. Bei großen Dateien gezielt suchen statt alles zu laden."
    );
  }
  const blocks = attachments.map((a) => {
    const content = a.content ?? "";
    const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((m) => m.length));
    const fence = "`".repeat(longest + 1);
    return `Datei: ${a.name}\n${fence}\n${content}\n${fence}`;
  });
  return `${question}\n\nAngehängte Dateien (Inhalt beachten):\n\n${blocks.join("\n\n")}`;
}

/**
 * Kopiert die Anhänge in einen eigenen Ordner. Die CLIs bekommen nur diesen Ordner als
 * Arbeitsordner und sehen so weder die Originale noch andere Dateien. Alte Ordner (älter als 24 h) werden gelöscht.
 */
export function prepareFileWorkspace(workspace: string, attachments: Attachment[]): string {
  const root = path.join(workspace, "files");
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    try {
      if (Date.now() - statSync(dir).mtimeMs > 24 * 3600_000) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignorieren */
    }
  }
  const dir = path.join(root, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir);
  const used = new Set<string>();
  for (const a of attachments) {
    let name = a.name;
    for (let i = 2; used.has(name); i++) name = `${path.parse(a.name).name} (${i})${path.parse(a.name).ext}`;
    used.add(name);
    copyFileSync(a.path, path.join(dir, name));
  }
  return dir;
}

const STATUS_TIMEOUT_MS = 15_000;

/** Modellnamen dürfen nur harmlose Zeichen enthalten (kein Leerzeichen, keine Optionen). */
export function validModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\-[\]/]*$/.test(value)) throw new Error(`Ungültiger Modellname: ${value}`);
  return value;
}

export function argumentsFor(provider: string, model?: string, fileAccess = false): string[] {
  const chosen = validModel(model);
  let base = baseArguments(provider);
  if (fileAccess && provider === "claude") {
    // Nur lesende Werkzeuge freigeben, und zwar ohne Rückfrage. Alles andere bleibt aus.
    const index = base.indexOf("--tools");
    base = [...base.slice(0, index), "--tools", "Read,Grep,Glob", "--allowedTools", "Read", "Grep", "Glob", ...base.slice(index + 2)];
  }
  if (fileAccess && provider === "gemini") base = base.map((arg) => (arg === "180s" ? "600s" : arg));
  if (!chosen) return base;
  // Bei Codex muss das Modell vor dem abschließenden "-" (Prompt von stdin) stehen.
  if (provider === "codex") return [...base.slice(0, -1), "--model", chosen, "-"];
  return [...base, "--model", chosen];
}

export type ModelOption = { value: string; label: string };
export type ModelGroup = { title: string; options: ModelOption[] };

/**
 * Claude-Modelle nach Familie. Der Alias zeigt immer auf die neueste Version,
 * die vollen Namen wählen eine feste Version.
 * Stand Oktober 2026, aktive Modelle laut Anthropic-Doku (Model deprecations).
 */
export const CLAUDE_GROUPS: ModelGroup[] = [
  {
    title: "Fable",
    options: [
      { value: "fable", label: "Neueste (fable)" },
      { value: "claude-fable-5-1", label: "Fable 5.1" },
    ],
  },
  {
    title: "Opus",
    options: [
      { value: "opus", label: "Neueste (opus)" },
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-opus-5", label: "Opus 5" },
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-opus-4-7", label: "Opus 4.7" },
      { value: "claude-opus-4-6", label: "Opus 4.6" },
      { value: "claude-opus-4-5-20251101", label: "Opus 4.5" },
    ],
  },
  {
    title: "Sonnet",
    options: [
      { value: "sonnet", label: "Neueste (sonnet)" },
      { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    ],
  },
  {
    title: "Haiku",
    options: [
      { value: "haiku", label: "Neueste (haiku)" },
      { value: "claude-haiku-5-5", label: "Haiku 5.5" },
    ],
  },
];

/** Gruppiert Gemini-Slugs nach Familie, z. B. gemini-3.1-pro-high → „Pro“. */
export function groupGeminiModels(slugs: string[]): ModelGroup[] {
  const groups = new Map<string, ModelOption[]>();
  for (const slug of slugs) {
    const parts = slug.split("-");
    const family = parts.length >= 3 && parts[0] === "gemini" ? parts[2] : "Weitere";
    const title = family.charAt(0).toUpperCase() + family.slice(1);
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title)!.push({ value: slug, label: slug });
  }
  return [...groups].map(([title, options]) => ({ title, options }));
}

/** Liest Modell-Slugs aus der Ausgabe von `agy models`. */
export function parseModelList(output: string): string[] {
  const slugs = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const token = raw.replace(/^[\s*•>-]+/, "").split(/\s+/)[0] ?? "";
    if (/^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+$/.test(token)) slugs.add(token);
  }
  return [...slugs];
}

function baseArguments(provider: string): string[] {
  switch (provider) {
    case "gemini":
      return ["--input-format", "stream-json", "--output-format", "stream-json", "--mode", "plan", "--sandbox", "--print-timeout", "180s"];
    case "claude":
      return [
        "--print",
        "--output-format",
        "json",
        "--append-system-prompt",
        SYSTEM_PROMPT,
        "--tools",
        "",
        "--disallowedTools",
        "mcp__*",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--no-chrome",
        "--permission-prompts",
        "none",
      ];
    case "codex":
      return ["exec", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--json", "-"];
    default:
      throw new Error("Unbekannter Anbieter.");
  }
}

/** Entfernt API-Schlüssel und alternative Endpunkte, damit nur die Abo-Anmeldung genutzt wird. */
export function cleanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|GOOGLE_API_KEY|GEMINI_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_PROJECT_ID|GOOGLE_CLOUD_LOCATION|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/i.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}

/**
 * PATH aus der Login-Shell des Nutzers, also dasselbe wie im Terminal.
 * Raycast startet Erweiterungen ohne dieses PATH. Ergebnis wird zwischengespeichert.
 */
let cachedShellDirs: string[] | undefined;
export function loginShellDirectories(): string[] {
  if (cachedShellDirs) return cachedShellDirs;
  cachedShellDirs = [];
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const output = execFileSync(shell, ["-lc", 'printf "\n__AIHUB_PATH__%s" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const marker = output.lastIndexOf("__AIHUB_PATH__");
    if (marker >= 0)
      cachedShellDirs = output
        .slice(marker + "__AIHUB_PATH__".length)
        .trim()
        .split(path.delimiter)
        .filter(Boolean);
  } catch {
    /* Shell nicht nutzbar, feste Ordnerliste reicht */
  }
  return cachedShellDirs;
}

/** Ordner, in denen CLIs auf dem Mac typischerweise liegen. Reihenfolge: Terminal-PATH, Installer-Ordner, Rest. */
export function searchDirectories(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), shellDirs: string[] = []): string[] {
  const dirs = [
    ...shellDirs,
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".antigravity", "bin"),
    path.join(home, ".agy", "bin"),
    path.join(home, "Library", "pnpm"),
    ...(env.PATH || "").split(path.delimiter),
    "/usr/bin",
    "/bin",
  ];
  if (env.NPM_CONFIG_PREFIX) dirs.push(path.join(env.NPM_CONFIG_PREFIX, "bin"));
  return [...new Set(dirs.filter(Boolean))];
}

export function executableName(provider: Provider): string {
  return provider === "gemini" ? "agy" : provider;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Liest die Shebang-Zeile. npm-Wrapper (#!/usr/bin/env node) brauchen ein Node, das Raycast nicht im PATH hat. */
function needsNode(file: string): boolean {
  if (/\.(c|m)?js$/.test(file)) return true;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(128);
    const bytes = readSync(fd, buffer, 0, 128, 0);
    const head = buffer.subarray(0, bytes).toString("utf8");
    return head.startsWith("#!") && /\bnode\b/.test(head.split("\n")[0]);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type CustomPaths = Partial<Record<Provider, string>>;

export function resolveExecutable(
  provider: Provider,
  custom: CustomPaths = {},
  env: NodeJS.ProcessEnv = process.env,
  shellDirs: string[] = [],
): [string, string[]] {
  const candidates: string[] = [];
  const configured = custom[provider]?.trim();
  if (configured) candidates.push(configured.replace(/^~(?=\/|$)/, os.homedir()));
  for (const dir of searchDirectories(env, os.homedir(), shellDirs)) candidates.push(path.join(dir, executableName(provider)));
  const found = candidates.find(isFile);
  if (!found) {
    if (configured) throw new Error(`${LABELS[provider]}: Pfad aus den Einstellungen nicht gefunden (${configured}).`);
    const name = provider === "gemini" ? "Antigravity CLI (agy)" : LABELS[provider];
    throw new Error(`${name} nicht gefunden. Bitte installieren, einmal im Terminal anmelden oder den Pfad in den Erweiterungs-Einstellungen eintragen.`);
  }
  let target = found;
  try {
    target = realpathSync(found);
  } catch {
    /* Symlink nicht auflösbar, Originalpfad verwenden */
  }
  return needsNode(target) ? [process.execPath, [target]] : [found, []];
}

export function parseAnswer(provider: Provider, stdout: string): string {
  if (provider === "gemini") {
    const events = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const result = events.filter((event) => event.event === "result").at(-1)?.result;
    if (!result) throw new Error("Antigravity hat kein Ergebnis geliefert.");
    if (result.status !== "SUCCESS") throw new Error(result.error || `Antigravity-Anfrage beendet: ${result.status || "unbekannt"}.`);
    return result.response;
  }
  if (provider === "codex") {
    const events = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const error = events.find((e) => e.type === "error" || e.type === "turn.failed");
    if (error) throw new Error(error.message || error.error?.message || "Codex-Anfrage fehlgeschlagen.");
    return events
      .filter((e) => e.type === "item.completed" && e.item?.type === "agent_message")
      .map((e) => e.item.text)
      .join("\n");
  }
  const obj = JSON.parse(stdout);
  if (obj.is_error || obj.error) throw new Error(obj.error?.message || obj.result || "Anfrage fehlgeschlagen.");
  return obj.result;
}

/**
 * Liest aus der CLI-Ausgabe, welches Modell tatsächlich geantwortet hat.
 * Claude meldet das in modelUsage, Gemini und Codex je nach Version in einem Feld "model".
 * Gibt undefined zurück, wenn die CLI nichts meldet.
 */
export function parseModel(provider: Provider, stdout: string): string | undefined {
  try {
    if (provider === "claude") {
      const usage = JSON.parse(stdout).modelUsage as Record<string, { outputTokens?: number }> | undefined;
      if (!usage) return undefined;
      // Claude Code nutzt intern teils ein kleines Hilfsmodell. Das Hauptmodell hat die meisten Ausgabe-Tokens.
      return Object.entries(usage).sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0))[0]?.[0];
    }
    let found: string | undefined;
    const visit = (value: unknown, depth: number) => {
      if (!value || typeof value !== "object" || depth > 4) return;
      for (const [key, inner] of Object.entries(value)) {
        if (/^model(_?(name|slug|id))?$/i.test(key) && typeof inner === "string" && inner.trim()) found = inner.trim();
        else visit(inner, depth + 1);
      }
    };
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) visit(JSON.parse(line), 0);
    return found;
  } catch {
    return undefined;
  }
}

export function summarizeCliFailure(stderr: string, stdout: string, code: number | null): string {
  const combined = `${stderr}\n${stdout}`;
  const reason = combined.match(/reasonMessage:\s*'([^']+)'/);
  if (reason) return reason[1];
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = lines.find((line) => /^(Error authenticating:|Error:|Failed to |Not logged in)/i.test(line));
  return (preferred || lines.find((line) => !/^Warning:/i.test(line)) || `CLI beendet (${code}). Bitte Anmeldung im Terminal prüfen.`).replace(
    /^Error authenticating:\s*/i,
    "",
  );
}

export function buildPrompt(question: string, history: ChatMessage[] = []): string {
  return (
    `SYSTEMANWEISUNG (höchste Priorität):\n${SYSTEM_PROMPT}\n\n` +
    history
      .slice(-12)
      .map((m) => `${m.role}: ${m.text}`)
      .join("\n") +
    `\nuser: ${question}`
  );
}

/** Beendet den ganzen Prozessbaum. Kinder laufen in einer eigenen Prozessgruppe (detached). */
export function terminateProcessTree(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* bereits beendet */
    }
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* bereits beendet */
      }
    }
  }, 1500).unref();
}

type Options = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };

function abortError(): Error {
  const error = new Error("Abgebrochen.");
  error.name = "AbortError";
  return error;
}

function execute(command: string, args: string[], input: string | null, options: Options, timeoutMs: number, maxStdout: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortError());
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      terminateProcessTree(child);
    };
    const onAbort = () => stop(abortError());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop(new Error(`Zeitlimit nach ${Math.round(timeoutMs / 1000)} Sekunden erreicht.`)), timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => {
      stdout += data;
      if (stdout.length > maxStdout) stop(new Error("Antwort überschreitet das Größenlimit."));
    });
    child.stderr!.on("data", (data: string) => {
      stderr = (stderr + data).slice(-8000);
    });
    const finish = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      finish();
      reject(error);
    });
    child.on("close", (code) => {
      finish();
      if (failure) return reject(failure);
      resolve({ code, stdout, stderr });
    });
    if (input !== null) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
    }
  });
}

async function assertSubscriptionAuth(provider: Provider, command: string, prefix: string[], options: Options) {
  if (provider === "gemini") return;
  const args = provider === "claude" ? ["auth", "status"] : ["login", "status"];
  let status;
  try {
    status = await execute(command, [...prefix, ...args], null, options, STATUS_TIMEOUT_MS, 50_000);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new Error(`${LABELS[provider]}: Anmeldestatus konnte nicht geprüft werden.`);
  }
  if (status.code !== 0) {
    throw new Error(`${LABELS[provider]}: Anmeldung fehlt. Bitte im Terminal anmelden. (${summarizeCliFailure(status.stderr, status.stdout, status.code)})`);
  }
  if (provider === "claude") {
    let auth;
    try {
      auth = JSON.parse(status.stdout);
    } catch {
      throw new Error("Claude-Anmeldestatus ist nicht lesbar.");
    }
    if (!auth.loggedIn || auth.authMethod !== "claude.ai" || auth.apiProvider !== "firstParty") {
      throw new Error("Claude nutzt keine Claude-Abo-Anmeldung. Bitte im Terminal mit claude auth login anmelden.");
    }
  } else if (!/Logged in using ChatGPT/i.test(status.stdout + status.stderr)) {
    throw new Error("Codex nutzt keine ChatGPT-Anmeldung. Bitte im Terminal mit codex login anmelden.");
  }
}

export type RunRequest = {
  provider: Provider;
  prompt: string;
  history?: ChatMessage[];
  workspace: string;
  /** Ordner mit kopierten Anhängen. Ist er gesetzt, arbeitet die CLI darin und darf Dateien lesen. */
  filesDir?: string;
  customPaths?: CustomPaths;
  model?: string;
  signal?: AbortSignal;
};

/**
 * Nur für die Fehlersuche: Ist AIHUB_DEBUG_FILE gesetzt, wird jede Rohausgabe der CLIs dort angehängt.
 * Der Prompt selbst wird nicht protokolliert.
 */
function writeDebugLog(provider: Provider, args: string[], cwd: string, code: number | null, stdout: string, stderr: string) {
  const file = process.env.AIHUB_DEBUG_FILE;
  if (!file) return;
  const shownArgs = args.map((a) => (a === SYSTEM_PROMPT ? "<Stilprompt>" : a)).join(" ");
  const clip = (text: string) => (text.length > 20_000 ? `${text.slice(0, 10_000)}\n[… gekürzt …]\n${text.slice(-10_000)}` : text);
  appendFileSync(
    file,
    `\n===== ${provider} | ${new Date().toISOString()} | Exit ${code}\nArgumente: ${shownArgs}\nOrdner: ${cwd}\n----- stdout\n${clip(stdout)}\n----- stderr\n${clip(stderr)}\n`,
  );
}

export type RunResult = { text: string; model?: string };

export async function run(request: RunRequest): Promise<RunResult> {
  const fileAccess = Boolean(request.filesDir);
  const args = argumentsFor(request.provider, request.model, fileAccess);
  if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("Frage fehlt.");
  const prompt = buildPrompt(request.prompt, Array.isArray(request.history) ? request.history : []);
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error("Gespräch zu lang. Bitte ein neues Gespräch beginnen.");

  const shellDirs = loginShellDirectories();
  const [command, prefix] = resolveExecutable(request.provider, request.customPaths, process.env, shellDirs);
  mkdirSync(request.workspace, { recursive: true });
  const env = cleanEnvironment(process.env);
  // Damit npm-Wrapper und Hilfsprogramme der CLIs gefunden werden.
  env.PATH = [path.dirname(process.execPath), ...searchDirectories(process.env, os.homedir(), shellDirs)].join(path.delimiter);
  // Raycast setzt diese Variablen nicht immer. Claude Code braucht sie u. a. für den Schlüsselbund.
  const user = os.userInfo();
  env.HOME ||= user.homedir;
  env.USER ||= user.username;
  env.LOGNAME ||= user.username;
  env.SHELL ||= user.shell || "/bin/zsh";
  const options: Options = { cwd: request.filesDir ?? request.workspace, env, signal: request.signal };

  await assertSubscriptionAuth(request.provider, command, prefix, options);

  const input = request.provider === "gemini" ? JSON.stringify({ event: "user", message: { content: prompt } }) + "\n" : prompt;
  const { code, stdout, stderr } = await execute(command, [...prefix, ...args], input, options, fileAccess ? FILE_TIMEOUT_MS : ANSWER_TIMEOUT_MS, 4_000_000);
  writeDebugLog(request.provider, args, options.cwd, code, stdout, stderr);
  if (code !== 0) {
    if (stdout.trim()) {
      try {
        parseAnswer(request.provider, stdout);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    throw new Error(summarizeCliFailure(stderr, stdout, code));
  }
  const answer = parseAnswer(request.provider, stdout);
  if (!answer) throw new Error("Keine Textantwort erhalten.");
  return { text: answer, model: parseModel(request.provider, stdout) };
}

/** Modellgruppen für das Menü. Gemini wird live über `agy models` abgefragt. */
export async function listModels(provider: Provider, customPaths: CustomPaths = {}): Promise<ModelGroup[]> {
  if (provider === "claude") return CLAUDE_GROUPS;
  if (provider === "codex") return [];
  const shellDirs = loginShellDirectories();
  const [command, prefix] = resolveExecutable(provider, customPaths, process.env, shellDirs);
  const env = cleanEnvironment(process.env);
  env.PATH = [path.dirname(process.execPath), ...searchDirectories(process.env, os.homedir(), shellDirs)].join(path.delimiter);
  const { code, stdout, stderr } = await execute(command, [...prefix, "models"], null, { cwd: os.homedir(), env }, STATUS_TIMEOUT_MS, 200_000);
  if (code !== 0) throw new Error(summarizeCliFailure(stderr, stdout, code));
  return groupGeminiModels(parseModelList(stdout));
}
