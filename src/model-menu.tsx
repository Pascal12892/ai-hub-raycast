import { Action, ActionPanel, Form, Icon, LocalStorage, showToast, Toast, useNavigation } from "@raycast/api";
import { useState } from "react";
import { LABELS, MODEL_PRESETS, listModels, validModel, type CustomPaths, type Provider } from "./bridge";

export type ModelChoice = Record<Provider, string>;

const KEY = (provider: Provider) => `model.${provider}`;
const RECENT_KEY = (provider: Provider) => `recentModels.${provider}`;

export async function loadModels(): Promise<{ models: ModelChoice; recent: Record<Provider, string[]> }> {
  const providers: Provider[] = ["gemini", "claude", "codex"];
  const models = {} as ModelChoice;
  const recent = {} as Record<Provider, string[]>;
  for (const p of providers) {
    try {
      models[p] = (await LocalStorage.getItem<string>(KEY(p))) ?? "";
      recent[p] = JSON.parse((await LocalStorage.getItem<string>(RECENT_KEY(p))) ?? "[]");
    } catch {
      models[p] = "";
      recent[p] = [];
    }
  }
  return { models, recent };
}

export async function saveModel(provider: Provider, model: string, recent: string[]): Promise<string[]> {
  if (model) await LocalStorage.setItem(KEY(provider), model);
  else await LocalStorage.removeItem(KEY(provider));
  const nextRecent = model ? [model, ...recent.filter((m) => m !== model)].slice(0, 5) : recent;
  await LocalStorage.setItem(RECENT_KEY(provider), JSON.stringify(nextRecent));
  return nextRecent;
}

const HINTS: Record<Provider, string> = {
  claude: "Alias wie fable, opus, sonnet, haiku oder ein voller Name wie claude-opus-5-5.",
  gemini: "Slug aus `agy models`, z. B. gemini-3.1-pro-high.",
  codex: "Modellname, wie er in Codex mit /model angezeigt wird.",
};

function CustomModelForm(props: { provider: Provider; current: string; onSelect: (model: string) => void }) {
  const { pop } = useNavigation();
  const [error, setError] = useState<string | undefined>();
  return (
    <Form
      navigationTitle={`Modell für ${LABELS[props.provider]}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Modell übernehmen"
            onSubmit={(values: { model: string }) => {
              try {
                props.onSelect(validModel(values.model) ?? "");
                pop();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="model"
        title="Modell"
        placeholder="leer lassen für Standard"
        defaultValue={props.current}
        error={error}
        onChange={() => setError(undefined)}
      />
      <Form.Description text={HINTS[props.provider]} />
    </Form>
  );
}

/** Untermenü im Aktionsmenü (Cmd+K) zur Modellwahl für einen Anbieter. */
export function ModelSubmenu(props: {
  provider: Provider;
  current: string;
  recent: string[];
  customPaths: CustomPaths;
  onSelect: (model: string) => void;
  title?: string;
  shortcut?: boolean;
}) {
  const { provider, current, recent, onSelect } = props;
  const [listed, setListed] = useState<string[] | undefined>(provider === "gemini" ? undefined : MODEL_PRESETS[provider]);

  const load = () => {
    if (listed !== undefined) return;
    setListed([]);
    listModels(provider, props.customPaths)
      .then((models) => setListed(models))
      .catch((error: Error) => showToast({ style: Toast.Style.Failure, title: "Modellliste nicht verfügbar", message: error.message }));
  };

  const options = [...new Set([...(listed ?? []), ...recent, ...(current ? [current] : [])])];
  const mark = (model: string) => (model === current ? Icon.CheckCircle : Icon.Circle);

  return (
    <ActionPanel.Submenu
      title={props.title ?? `Modell wählen (${current || "Standard"})`}
      icon={Icon.ComputerChip}
      shortcut={props.shortcut ? { modifiers: ["cmd"], key: "m" } : undefined}
      onOpen={load}
    >
      <Action title="Standard" icon={mark("")} onAction={() => onSelect("")} />
      {options.map((model) => (
        <Action key={model} title={model} icon={mark(model)} onAction={() => onSelect(model)} />
      ))}
      <Action.Push title="Eigenes Modell eingeben…" icon={Icon.Pencil} target={<CustomModelForm provider={provider} current={current} onSelect={onSelect} />} />
    </ActionPanel.Submenu>
  );
}
