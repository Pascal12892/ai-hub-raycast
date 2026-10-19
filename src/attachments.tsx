import { Action, ActionPanel, Form, Icon, getSelectedFinderItems, showToast, Toast, useNavigation } from "@raycast/api";
import { useState } from "react";
import { MAX_FILE_BYTES, readAttachments, type Attachment } from "./bridge";

/** Liest Dateien ein und meldet Fehler als Toast. Gibt null zurück, wenn etwas nicht passt. */
export function loadAttachments(paths: string[]): Attachment[] | null {
  try {
    return readAttachments(paths);
  } catch (error) {
    showToast({ style: Toast.Style.Failure, title: "Datei kann nicht angehängt werden", message: (error as Error).message });
    return null;
  }
}

export async function attachFinderSelection(onAttach: (files: Attachment[]) => void) {
  let items: { path: string }[];
  try {
    items = await getSelectedFinderItems();
  } catch {
    await showToast({ style: Toast.Style.Failure, title: "Keine Finder-Auswahl", message: "Im Finder Dateien markieren und Raycast erneut öffnen." });
    return;
  }
  if (items.length === 0) {
    await showToast({ style: Toast.Style.Failure, title: "Im Finder ist nichts markiert" });
    return;
  }
  const files = loadAttachments(items.map((i) => i.path));
  if (files) onAttach(files);
}

export function AttachForm(props: { onAttach: (files: Attachment[]) => void }) {
  const { pop } = useNavigation();
  const [error, setError] = useState<string | undefined>();
  return (
    <Form
      navigationTitle="Dateien anhängen"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Anhängen"
            icon={Icon.Paperclip}
            onSubmit={(values: { files: string[] }) => {
              if (!values.files?.length) {
                setError("Bitte mindestens eine Datei wählen.");
                return;
              }
              const files = loadAttachments(values.files);
              if (!files) return;
              props.onAttach(files);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.FilePicker id="files" title="Dateien" allowMultipleSelection canChooseDirectories={false} error={error} onChange={() => setError(undefined)} />
      <Form.Description
        text={`Textdateien wie .txt, .md, .csv, .json, .py oder .ts, je Datei höchstens ${MAX_FILE_BYTES / 1000} KB. Bilder, PDFs und Office-Dateien werden noch nicht unterstützt.`}
      />
    </Form>
  );
}
