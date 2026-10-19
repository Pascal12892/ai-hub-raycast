import { Action, ActionPanel, Color, Icon, Keyboard, List, environment, getPreferenceValues, openExtensionPreferences, showToast, Toast } from "@raycast/api";
import path from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
import { LABELS, run, withAttachments, type Attachment, type ChatMessage, type CustomPaths, type Provider } from "./bridge";
import { AttachForm, attachFinderSelection } from "./attachments";
import { ModelSubmenu, loadModels, saveModel, type ModelChoice } from "./model-menu";

type Preferences = { claudePath?: string; codexPath?: string; agyPath?: string };

type Status = "idle" | "running" | "done" | "error" | "cancelled";
type ProviderState = {
  status: Status;
  question?: string;
  answer?: string;
  error?: string;
  history: ChatMessage[];
  /** Fragen so, wie sie angezeigt werden (ohne eingefügten Dateiinhalt). */
  shownQuestions: string[];
  /** Modellangabe je beantworteter Frage, parallel zu den Antworten in history. */
  modelNotes: string[];
  /** Zuletzt tatsächlich genutztes Modell, falls die CLI es meldet. */
  usedModel?: string;
};

const ICONS: Record<Provider, string> = { gemini: "gemini.png", claude: "claude.png", codex: "codex.png" };

function emptyState(providers: Provider[]): Record<string, ProviderState> {
  return Object.fromEntries(providers.map((p) => [p, { status: "idle", history: [], shownQuestions: [], modelNotes: [] } satisfies ProviderState]));
}

function customPaths(): CustomPaths {
  const prefs = getPreferenceValues<Preferences>();
  return { claude: prefs.claudePath, codex: prefs.codexPath, gemini: prefs.agyPath };
}

function markdownFor(state: ProviderState): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < state.history.length; i += 2) {
    const note = state.modelNotes[i / 2];
    parts.push(`**Du:** ${state.shownQuestions[i / 2] ?? state.history[i].text}\n\n${state.history[i + 1].text}${note ? `\n\n_${note}_` : ""}`);
  }
  if (state.status === "running") parts.push(`**Du:** ${state.question}\n\n_Antwort läuft…_`);
  if (state.status === "error") parts.push(`**Du:** ${state.question}\n\n**Fehler:** ${state.error}`);
  if (state.status === "cancelled") parts.push(`**Du:** ${state.question}\n\n_Abgebrochen._`);
  return parts.join("\n\n---\n\n") || "_Noch keine Anfrage._";
}

/** Text unter jeder Antwort: welches Modell gemeldet wurde und ob es zur Auswahl passt. */
function modelNote(label: string, requested: string, used: string | undefined): string {
  if (used) {
    if (!requested) return `Modell: ${used} (Standard, von ${label} gemeldet)`;
    return `Modell: ${used} (gewählt: ${requested}, von ${label} gemeldet)`;
  }
  return `Modell: ${requested || "Standard"} (gewählt, ${label} meldet das genutzte Modell nicht)`;
}

function subtitleFor(state: ProviderState): string {
  if (state.status === "running") return "Antwort läuft…";
  if (state.status === "error") return state.error ?? "Fehler";
  if (state.status === "cancelled") return "Abgebrochen";
  if (state.status === "done") return (state.answer ?? "").replace(/\s+/g, " ").slice(0, 120);
  return "";
}

function accessoryFor(status: Status, model: string): List.Item.Accessory[] {
  const tag: List.Item.Accessory[] = model ? [{ tag: model, tooltip: "Modell (nach einer Antwort das gemeldete)" }] : [];
  return [...tag, ...statusAccessory(status)];
}

function statusAccessory(status: Status): List.Item.Accessory[] {
  switch (status) {
    case "running":
      return [{ icon: { source: Icon.Clock, tintColor: Color.Orange }, tooltip: "Läuft" }];
    case "done":
      return [{ icon: { source: Icon.Checkmark, tintColor: Color.Green }, tooltip: "Fertig" }];
    case "error":
      return [{ icon: { source: Icon.Warning, tintColor: Color.Red }, tooltip: "Fehler" }];
    case "cancelled":
      return [{ icon: { source: Icon.XMarkCircle, tintColor: Color.SecondaryText }, tooltip: "Abgebrochen" }];
    default:
      return [];
  }
}

export function AskView(props: { providers: Provider[]; initialQuestion?: string }) {
  const { providers, initialQuestion } = props;
  const [states, setStates] = useState<Record<string, ProviderState>>(() => emptyState(providers));
  const [searchText, setSearchText] = useState("");
  const controllers = useRef(new Map<Provider, AbortController>());
  const statesRef = useRef(states);
  statesRef.current = states;
  const started = useRef(false);
  const [models, setModels] = useState<ModelChoice>({ gemini: "", claude: "", codex: "" });
  const [recent, setRecent] = useState<Record<Provider, string[]>>({ gemini: [], claude: [], codex: [] });
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const update = (provider: Provider, change: (s: ProviderState) => ProviderState) => setStates((prev) => ({ ...prev, [provider]: change(prev[provider]) }));

  const send = useCallback(
    (raw: string) => {
      const files = attachmentsRef.current;
      const question = raw.trim() || (files.length ? "Bitte die angehängten Dateien zusammenfassen." : "");
      if (!question) return;
      const prompt = withAttachments(question, files);
      const shown = files.length ? `${question}\n\n📎 ${files.map((f) => f.name).join(", ")}` : question;
      if (providers.some((p) => statesRef.current[p].status === "running")) {
        showToast({ style: Toast.Style.Failure, title: "Es läuft noch eine Anfrage", message: "Erst abbrechen oder warten." });
        return;
      }
      setSearchText("");
      setAttachments([]);
      const paths = customPaths();
      const workspace = path.join(environment.supportPath, "Workspace");
      for (const provider of providers) {
        const controller = new AbortController();
        controllers.current.set(provider, controller);
        const history = statesRef.current[provider].history;
        const requested = modelsRef.current[provider];
        update(provider, (s) => ({ ...s, status: "running", question: shown, error: undefined }));
        run({ provider, prompt, history, workspace, customPaths: paths, model: requested, signal: controller.signal })
          .then(({ text, model }) =>
            update(provider, (s) => ({
              ...s,
              status: "done",
              answer: text,
              usedModel: model,
              modelNotes: [...s.modelNotes, modelNote(LABELS[provider], requested, model)],
              shownQuestions: [...s.shownQuestions, shown],
              history: [...s.history, { role: "user", text: prompt }, { role: "assistant", text }],
            })),
          )
          .catch((error: Error) =>
            update(provider, (s) => (error.name === "AbortError" ? { ...s, status: "cancelled" } : { ...s, status: "error", error: error.message })),
          )
          .finally(() => {
            if (controllers.current.get(provider) === controller) controllers.current.delete(provider);
          });
      }
    },
    [providers],
  );

  const cancel = () => {
    for (const controller of controllers.current.values()) controller.abort();
  };

  const reset = () => {
    cancel();
    setStates(emptyState(providers));
  };

  useEffect(() => {
    loadModels()
      .then(({ models, recent }) => {
        setModels(models);
        setRecent(recent);
      })
      .finally(() => setModelsLoaded(true));
    return () => {
      for (const controller of controllers.current.values()) controller.abort();
    };
  }, []);

  // Erst senden, wenn die gespeicherten Modelle geladen sind.
  useEffect(() => {
    if (!modelsLoaded) return;
    if (!started.current && initialQuestion?.trim()) {
      started.current = true;
      send(initialQuestion);
    }
  }, [modelsLoaded]);

  const selectModel = (provider: Provider, model: string) => {
    setModels((prev) => ({ ...prev, [provider]: model }));
    saveModel(provider, model, recent[provider])
      .then((next) => setRecent((prev) => ({ ...prev, [provider]: next })))
      .catch(() => {});
    showToast({ style: Toast.Style.Success, title: `${LABELS[provider]}: ${model || "Standardmodell"}`, message: "Gilt ab der nächsten Frage." });
  };

  const paths = customPaths();
  const submenuFor = (provider: Provider, withShortcut: boolean) => (
    <ModelSubmenu
      key={provider}
      provider={provider}
      current={models[provider]}
      recent={recent[provider]}
      customPaths={paths}
      onSelect={(model) => selectModel(provider, model)}
      title={providers.length > 1 ? `${LABELS[provider]} (${models[provider] || "Standard"})` : undefined}
      shortcut={withShortcut}
    />
  );

  // Ein Anbieter: Cmd+M öffnet direkt seine Modellliste.
  // Mehrere Anbieter: Cmd+M öffnet ein Menü mit allen Anbietern, der markierte steht oben.
  const modelMenus = (focused?: Provider) => {
    if (providers.length === 1) return <ActionPanel.Section title="Modell">{submenuFor(providers[0], true)}</ActionPanel.Section>;
    const ordered = focused ? [focused, ...providers.filter((p) => p !== focused)] : providers;
    return (
      <ActionPanel.Section title="Modelle">
        <ActionPanel.Submenu title="Modelle wählen" icon={Icon.ComputerChip} shortcut={{ modifiers: ["cmd"], key: "m" }}>
          {ordered.map((provider) => submenuFor(provider, false))}
        </ActionPanel.Submenu>
      </ActionPanel.Section>
    );
  };

  const running = providers.some((p) => states[p].status === "running");
  const anyActivity = providers.some((p) => states[p].status !== "idle");
  const hasHistory = providers.some((p) => states[p].history.length > 0);
  const target = providers.length > 1 ? "alle drei" : LABELS[providers[0]];

  const addAttachments = (files: Attachment[]) => {
    setAttachments((prev) => {
      const byPath = new Map(prev.map((f) => [f.path, f]));
      for (const f of files) byPath.set(f.path, f);
      return [...byPath.values()];
    });
    showToast({
      style: Toast.Style.Success,
      title: `${files.length === 1 ? files[0].name : `${files.length} Dateien`} angehängt`,
      message: "Geht mit der nächsten Frage mit.",
    });
  };

  const attachActions = (
    <ActionPanel.Section title="Dateien">
      <Action.Push
        title="Dateien anhängen…"
        icon={Icon.Paperclip}
        shortcut={{ modifiers: ["cmd"], key: "o" }}
        target={<AttachForm onAttach={addAttachments} />}
      />
      <Action
        title="Finder-Auswahl anhängen"
        icon={Icon.Finder}
        shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
        onAction={() => attachFinderSelection(addAttachments)}
      />
      {attachments.length > 0 ? (
        <Action
          title={`Anhänge entfernen (${attachments.length})`}
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
          onAction={() => setAttachments([])}
        />
      ) : null}
    </ActionPanel.Section>
  );

  const attachmentInfo = attachments.length ? `📎 ${attachments.map((f) => f.name).join(", ")}` : "";

  const sendAction =
    searchText.trim() || attachments.length ? (
      <Action title={hasHistory ? "Rückfrage senden" : "Senden"} icon={Icon.ArrowRight} onAction={() => send(searchText)} />
    ) : null;

  const commonActions = (
    <>
      {running ? (
        <Action title="Abbrechen" icon={Icon.XMarkCircle} style={Action.Style.Destructive} shortcut={{ modifiers: ["ctrl"], key: "c" }} onAction={cancel} />
      ) : null}
      {anyActivity ? <Action title="Neues Gespräch" icon={Icon.Plus} shortcut={Keyboard.Shortcut.Common.New} onAction={reset} /> : null}
      <Action title="Einstellungen öffnen" icon={Icon.Gear} onAction={openExtensionPreferences} />
    </>
  );

  return (
    <List
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      isLoading={running}
      isShowingDetail={anyActivity}
      searchBarPlaceholder={
        (hasHistory ? "Rückfrage eingeben und Enter drücken" : `Frage an ${target} eingeben und Enter drücken`) +
        (attachments.length ? ` (${attachments.length} ${attachments.length === 1 ? "Datei" : "Dateien"} angehängt)` : "")
      }
    >
      {!anyActivity ? (
        <List.EmptyView
          icon={providers.length > 1 ? "all.png" : ICONS[providers[0]]}
          title={`Frage an ${target}`}
          description={`Tippen startet noch keine Anfrage. Erst Enter sendet.\n\nModelle: ${providers.map((p) => `${LABELS[p]} ${models[p] || "Standard"}`).join(", ")}  ·  Cmd+M zum Ändern${attachmentInfo ? `\n\n${attachmentInfo}` : "\n\nDateien anhängen: Cmd+O, Finder-Auswahl: Cmd+Shift+O"}`}
          actions={
            <ActionPanel>
              {sendAction}
              {modelMenus()}
              {attachActions}
              {commonActions}
            </ActionPanel>
          }
        />
      ) : (
        providers.map((provider) => {
          const state = states[provider];
          const copy =
            state.status === "done" && state.answer ? (
              <>
                <Action.CopyToClipboard title="Antwort kopieren" content={state.answer} />
                <Action.Paste title="Antwort einfügen" content={state.answer} shortcut={{ modifiers: ["cmd", "shift"], key: "v" }} />
              </>
            ) : null;
          return (
            <List.Item
              key={provider}
              id={provider}
              title={LABELS[provider]}
              subtitle={subtitleFor(state)}
              icon={ICONS[provider]}
              accessories={accessoryFor(state.status, state.status === "done" && state.usedModel ? state.usedModel : models[provider])}
              detail={<List.Item.Detail markdown={markdownFor(state)} />}
              actions={
                <ActionPanel>
                  {sendAction}
                  {copy}
                  {modelMenus(provider)}
                  {attachActions}
                  {commonActions}
                </ActionPanel>
              }
            />
          );
        })
      )}
    </List>
  );
}
