/**
 * Live-Test mit den echten CLIs auf deinem Mac. Nutzt deine Abo-Anmeldungen und verbraucht etwas Kontingent.
 *
 *   npm run test:live                 alle drei Anbieter
 *   npm run test:live -- claude codex nur bestimmte Anbieter
 *   npm run test:live -- --debug      zusätzlich Rohausgaben nach ~/aihub-debug.txt
 *
 * Geprüft wird pro Anbieter: CLI gefunden, Version, Anmeldung, Antwort, Umlaute, Rückfrage mit Verlauf,
 * gemeldetes Modell, eingefügte Textdatei, große Datei im Datei-Modus und Abbrechen.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LABELS,
  PROVIDERS,
  loginShellDirectories,
  needsFileAccess,
  prepareFileWorkspace,
  readAttachments,
  resolveExecutable,
  run,
  withAttachments,
  type Provider,
} from "../src/bridge.ts";

type Check = { name: string; ok: boolean; detail: string };

const debug = process.argv.includes("--debug");
const selected = process.argv.slice(2).filter((a): a is Provider => (PROVIDERS as string[]).includes(a));
const providers: Provider[] = selected.length ? selected : PROVIDERS;
const root = mkdtempSync(path.join(os.tmpdir(), "aihub-live-"));
// Mit --debug landen alle Rohausgaben der CLIs in einer Datei im Benutzerordner.
const debugFile = path.join(os.homedir(), "aihub-debug.txt");
if (debug) {
  writeFileSync(debugFile, `AI Hub Debug-Log ${new Date().toISOString()}\n`);
  process.env.AIHUB_DEBUG_FILE = debugFile;
}
const workspace = path.join(root, "workspace");

// Testdateien: eine kleine zum Einfügen, eine große (über 500 KB) für den Datei-Modus.
const smallFile = path.join(root, "klein.txt");
writeFileSync(smallFile, "Projektnotiz\nDas Codewort lautet: HIMBEERE\n");
const bigFile = path.join(root, "gross.txt");
const filler = "Diese Zeile ist nur Fülltext für den Test großer Dateien.\n".repeat(6000);
writeFileSync(bigFile, `${filler}Das geheime Codewort lautet: KOHLRABI\n${filler}`);

function version(provider: Provider): string {
  try {
    const [command, prefix] = resolveExecutable(provider, {}, process.env, loginShellDirectories());
    return execFileSync(command, [...prefix, "--version"], { encoding: "utf8", timeout: 15_000 })
      .trim()
      .split("\n")[0];
  } catch (error) {
    return `nicht ermittelbar (${(error as Error).message.split("\n")[0]})`;
  }
}

async function check(name: string, fn: () => Promise<string>): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail: `${detail} (${((Date.now() - started) / 1000).toFixed(1)} s)` };
  } catch (error) {
    return { name, ok: false, detail: (error as Error).message.split("\n")[0].slice(0, 160) };
  }
}

function expect(text: string, pattern: RegExp, what: string): string {
  if (!pattern.test(text)) throw new Error(`${what} fehlt. Antwort: ${text.slice(0, 120)}`);
  return text.replace(/\s+/g, " ").slice(0, 60);
}

async function testProvider(provider: Provider): Promise<Check[]> {
  const base = { provider, workspace };
  const checks: Check[] = [];

  checks.push(
    await check("Antwort und Umlaute", async () => {
      const { text } = await run({ ...base, prompt: "Antworte exakt mit: Grüße aus Köln ✓" });
      return expect(text, /Grüße aus Köln/, "Text mit Umlauten");
    }),
  );
  if (!checks[0].ok) return checks; // Ohne Grundfunktion lohnt sich der Rest nicht.

  checks.push(
    await check("Rückfrage mit Verlauf", async () => {
      const history = [
        { role: "user" as const, text: "Merke dir die Zahl 4711." },
        { role: "assistant" as const, text: "Gemerkt." },
      ];
      const { text } = await run({ ...base, prompt: "Welche Zahl solltest du dir merken? Nur die Zahl.", history });
      return expect(text, /4711/, "Zahl aus dem Verlauf");
    }),
  );

  checks.push(
    await check("Gemeldetes Modell", async () => {
      const { model } = await run({ ...base, prompt: "Antworte nur mit OK." });
      if (!model) throw new Error("CLI meldet kein Modell (in der App steht dann nur das gewählte Modell)");
      return model;
    }),
  );

  checks.push(
    await check("Textdatei eingefügt", async () => {
      const files = readAttachments([smallFile]);
      if (needsFileAccess(files)) throw new Error("kleine Datei wurde nicht eingefügt");
      const { text } = await run({ ...base, prompt: withAttachments("Wie lautet das Codewort? Nur das Wort.", files) });
      return expect(text, /HIMBEERE/i, "Codewort");
    }),
  );

  checks.push(
    await check("Große Datei (Datei-Modus)", async () => {
      const files = readAttachments([bigFile]);
      if (!needsFileAccess(files)) throw new Error("große Datei wurde nicht im Datei-Modus übergeben");
      const filesDir = prepareFileWorkspace(workspace, files);
      const { text } = await run({ ...base, filesDir, prompt: withAttachments("Wie lautet das geheime Codewort in der Datei? Nur das Wort.", files) });
      return expect(text, /KOHLRABI/i, "Codewort aus der großen Datei");
    }),
  );

  checks.push(
    await check("Abbrechen", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1500);
      try {
        await run({ ...base, prompt: "Schreibe einen sehr langen Aufsatz über Recycling.", signal: controller.signal });
      } catch (error) {
        if ((error as Error).name === "AbortError") return "abgebrochen";
        throw error;
      }
      throw new Error("Anfrage lief trotz Abbruch zu Ende");
    }),
  );

  return checks;
}

console.log(`AI Hub Live-Test, ${new Date().toLocaleString("de-DE")}`);
console.log(`${os.type()} ${os.release()}, ${os.arch()}, Node ${process.version}\n`);
for (const provider of providers) console.log(`${LABELS[provider].padEnd(7)} ${version(provider)}`);
console.log("\nLäuft parallel, das dauert ein paar Minuten …\n");

const results = await Promise.all(providers.map(async (provider) => [provider, await testProvider(provider)] as const));

let failed = 0;
for (const [provider, checks] of results) {
  console.log(LABELS[provider]);
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(26)} ${c.detail}`);
  }
  console.log("");
}
console.log(failed === 0 ? "Alle Live-Tests bestanden." : `${failed} Live-Test(s) fehlgeschlagen.`);
if (debug) console.log(`\nRohausgaben der CLIs: ${debugFile}`);
process.exitCode = failed === 0 ? 0 : 1;
