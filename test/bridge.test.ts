import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SYSTEM_PROMPT,
  CLAUDE_GROUPS,
  groupGeminiModels,
  argumentsFor,
  parseModelList,
  buildPrompt,
  cleanEnvironment,
  parseAnswer,
  resolveExecutable,
  run,
  summarizeCliFailure,
} from "../src/bridge.ts";

test("alle Anbieter laufen nicht interaktiv, unbekannte werden abgelehnt", () => {
  assert.ok(argumentsFor("gemini").includes("stream-json"));
  assert.ok(argumentsFor("gemini").includes("plan"));
  assert.ok(argumentsFor("gemini").includes("--sandbox"));
  assert.ok(argumentsFor("claude").includes("--print"));
  assert.ok(argumentsFor("claude").includes("--append-system-prompt"));
  assert.ok(argumentsFor("codex").includes("read-only"));
  assert.throws(() => argumentsFor("invalid"));
});

test("API-Zugangsdaten werden entfernt, ohne die Elternumgebung zu ändern", () => {
  const source = {
    PATH: "keep",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    GEMINI_API_KEY: "secret",
    GOOGLE_GENAI_USE_VERTEXAI: "true",
  };
  assert.deepEqual(cleanEnvironment(source), { PATH: "keep" });
  assert.equal(source.OPENAI_API_KEY, "secret");
});

test("Antworten werden pro Anbieter ausgelesen, Codex-Toolereignisse ignoriert", () => {
  const antigravity = [{ event: "init" }, { event: "result", result: { status: "SUCCESS", response: "Grüße 🌍" } }];
  assert.equal(parseAnswer("gemini", antigravity.map((e) => JSON.stringify(e)).join("\n")), "Grüße 🌍");
  assert.equal(parseAnswer("claude", '{"result":"Grüße 🌍","is_error":false}'), "Grüße 🌍");
  const events = [
    { type: "thread.started" },
    { type: "item.completed", item: { type: "command_execution", text: "ignore" } },
    { type: "item.completed", item: { type: "agent_message", text: "Hallo" } },
  ];
  assert.equal(parseAnswer("codex", events.map((e) => JSON.stringify(e)).join("\n")), "Hallo");
});

test("Fehler der Anbieter werden nicht zu Antworten", () => {
  assert.throws(() => parseAnswer("gemini", '{"event":"result","result":{"status":"ERROR","error":"Login fehlt"}}'), /Login fehlt/);
  assert.throws(() => parseAnswer("claude", '{"is_error":true,"result":"Login fehlt"}'), /Login fehlt/);
  assert.throws(() => parseAnswer("codex", '{"type":"turn.failed","error":{"message":"Limit"}}'), /Limit/);
  assert.equal(summarizeCliFailure("Warning: TERM=dumb\nreasonMessage: 'Konto nicht berechtigt'", "", 1), "Konto nicht berechtigt");
});

test("Systemprompt und begrenzter Verlauf", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, text: `Nachricht ${i}` }));
  const prompt = buildPrompt("Erkläre DNS", history);
  assert.match(SYSTEM_PROMPT, /Caveman-Ultra/);
  assert.doesNotMatch(prompt, /Nachricht 7/);
  assert.match(prompt, /Nachricht 8/);
  assert.match(prompt, /user: Erkläre DNS/);
});

// Gefälschte claude-CLI als npm-Wrapper mit Node-Shebang, wie bei einer npm-Installation.
function fakeClaude(dir: string, body: string): string {
  const file = path.join(dir, "claude");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }
${body}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

test("npm-Wrapper wird mit dem eigenen Node gestartet, auch ohne node im PATH", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aihub-"));
  const file = fakeClaude(dir, "");
  const [command, prefix] = resolveExecutable("claude", {}, { PATH: dir });
  assert.equal(command, process.execPath);
  assert.deepEqual(prefix, [file]);
});

test("Pfad aus den Einstellungen hat Vorrang, ungültiger Pfad gibt klare Meldung", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aihub-"));
  const file = path.join(dir, "codex-binary");
  writeFileSync(file, "\x7fELF");
  chmodSync(file, 0o755);
  assert.deepEqual(resolveExecutable("codex", { codex: file }, { PATH: "" }), [file, []]);
  assert.throws(() => resolveExecutable("codex", { codex: "/gibt/es/nicht" }, { PATH: "" }), /Einstellungen/);
});

test("kompletter Ablauf mit gefälschter CLI liefert die Antwort", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aihub-"));
  const file = fakeClaude(
    dir,
    `let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {
       console.log(JSON.stringify({ result: input.includes("user: Wie spät?") ? "Spät." : "falsch", is_error: false }));
     });`,
  );
  const answer = await run({ provider: "claude", prompt: "Wie spät?", workspace: path.join(dir, "ws"), customPaths: { claude: file } });
  assert.equal(answer, "Spät.");
});

test("Abbrechen beendet den Prozess", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aihub-"));
  const file = fakeClaude(dir, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  const pending = run({ provider: "claude", prompt: "x", workspace: path.join(dir, "ws"), customPaths: { claude: file }, signal: controller.signal });
  setTimeout(() => controller.abort(), 500);
  const started = Date.now();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  assert.ok(Date.now() - started < 5000);
});

test("Modellauswahl wird an die richtige Stelle gesetzt und geprüft", () => {
  assert.deepEqual(argumentsFor("claude", "opus").slice(-2), ["--model", "opus"]);
  assert.deepEqual(argumentsFor("gemini", "gemini-3.1-pro-high").slice(-2), ["--model", "gemini-3.1-pro-high"]);
  const codex = argumentsFor("codex", "gpt-5-codex");
  assert.deepEqual(codex.slice(-3), ["--model", "gpt-5-codex", "-"]);
  assert.deepEqual(argumentsFor("claude", "  "), argumentsFor("claude"));
  assert.throws(() => argumentsFor("claude", "--dangerously-skip-permissions"), /Ungültig/);
  assert.throws(() => argumentsFor("claude", "opus extra"), /Ungültig/);
  assert.equal(argumentsFor("claude", "opus[1m]").at(-1), "opus[1m]");
});

test("Modellliste von agy wird ausgelesen", () => {
  const output = "Available models:\n  * gemini-4-argon-high (default)\n  - gemini-3.8-flash-medium  Fast\ngemini-3.1-pro-high\nModel   Description\n";
  assert.deepEqual(parseModelList(output), ["gemini-4-argon-high", "gemini-3.8-flash-medium", "gemini-3.1-pro-high"]);
});

test("Modelle werden nach Familie gruppiert", () => {
  assert.deepEqual(
    CLAUDE_GROUPS.map((g) => g.title),
    ["Fable", "Opus", "Sonnet", "Haiku"],
  );
  for (const group of CLAUDE_GROUPS) for (const option of group.options) assert.ok(argumentsFor("claude", option.value));
  const groups = groupGeminiModels(["gemini-4-argon-high", "gemini-3.1-pro-high", "gemini-3.1-pro-low", "other-model"]);
  assert.deepEqual(
    groups.map((g) => [g.title, g.options.length]),
    [
      ["Argon", 1],
      ["Pro", 2],
      ["Weitere", 1],
    ],
  );
});
