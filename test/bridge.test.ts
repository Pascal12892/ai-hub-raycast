import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SYSTEM_PROMPT,
  CLAUDE_GROUPS,
  readAttachments,
  needsFileAccess,
  prepareFileWorkspace,
  withAttachments,
  parseModel,
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
  assert.equal(answer.text, "Spät.");
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

test("tatsächlich genutztes Modell wird aus der Ausgabe gelesen", () => {
  const claude = JSON.stringify({ result: "x", modelUsage: { "claude-haiku-5-5": { outputTokens: 3 }, "claude-opus-5-5": { outputTokens: 120 } } });
  assert.equal(parseModel("claude", claude), "claude-opus-5-5");
  assert.equal(parseModel("claude", '{"result":"x"}'), undefined);
  const gemini = [
    { event: "init", init: { model: "gemini-3.1-pro-high" } },
    { event: "result", result: { status: "SUCCESS", response: "x" } },
  ];
  assert.equal(parseModel("gemini", gemini.map((e) => JSON.stringify(e)).join("\n")), "gemini-3.1-pro-high");
  assert.equal(parseModel("codex", '{"type":"thread.started"}'), undefined);
});

test("kleine Textdateien werden eingefügt, große oder binäre Dateien im Datei-Modus übergeben", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aihub-"));
  const text = path.join(dir, "notizen.md");
  writeFileSync(text, "# Titel\n```py\nprint(1)\n```\nÄÖÜ");
  const png = path.join(dir, "bild.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
  const big = path.join(dir, "gross.csv");
  writeFileSync(big, "a,b\n".repeat(200_000));

  const [small] = readAttachments([text]);
  assert.ok(small.content);
  const prompt = withAttachments("Fass zusammen", [small]);
  assert.match(prompt, /Datei: notizen.md\n````\n# Titel/);
  assert.match(prompt, /ÄÖÜ\n````$/);
  assert.equal(withAttachments("Nur Frage", []), "Nur Frage");

  // Bild: Datei-Modus, auch zusammen mit einer kleinen Textdatei.
  const mixed = readAttachments([text, png]);
  assert.ok(needsFileAccess(mixed));
  assert.ok(mixed.every((a) => a.content === undefined));
  const filePrompt = withAttachments("Was ist darauf?", mixed);
  assert.match(filePrompt, /- bild.png \(1 KB\)/);
  assert.doesNotMatch(filePrompt, /print\(1\)/);

  // Große Textdatei: Datei-Modus statt Einfügen.
  assert.ok(needsFileAccess(readAttachments([big])));
  assert.throws(() => readAttachments([dir]), /Ordner/);

  const workspace = path.join(dir, "ws");
  const copyDir = prepareFileWorkspace(workspace, mixed);
  assert.deepEqual(readdirSync(copyDir).sort(), ["bild.png", "notizen.md"]);
});

test("Datei-Modus gibt Claude nur Lese-Werkzeuge und Gemini mehr Zeit", () => {
  const claude = argumentsFor("claude", undefined, true);
  assert.equal(claude[claude.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.ok(!claude.includes("Bash") && !claude.includes("Edit"));
  assert.equal(argumentsFor("claude")[argumentsFor("claude").indexOf("--tools") + 1], "");
  assert.ok(argumentsFor("gemini", undefined, true).includes("600s"));
  assert.deepEqual(argumentsFor("codex", undefined, true), argumentsFor("codex"));
});

test("im Datei-Modus läuft die CLI im Ordner mit den kopierten Anhängen", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aihub-"));
  const file = fakeClaude(
    dir,
    `process.stdin.resume(); process.stdin.on("end", () => {
       const tools = args[args.indexOf("--tools") + 1];
       console.log(JSON.stringify({ result: require("fs").readdirSync(".").join(",") + "|" + tools, is_error: false }));
     });`,
  );
  const source = path.join(dir, "daten.csv");
  writeFileSync(source, "x");
  const filesDir = prepareFileWorkspace(path.join(dir, "ws"), [{ name: "daten.csv", path: source, size: 1 }]);
  const answer = await run({ provider: "claude", prompt: "Lies", workspace: path.join(dir, "ws"), filesDir, customPaths: { claude: file } });
  assert.equal(answer.text, "daten.csv|Read,Grep,Glob");
});
