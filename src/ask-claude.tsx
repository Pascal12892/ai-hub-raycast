import type { LaunchProps } from "@raycast/api";
import { AskView } from "./ask-view";
import type { Provider } from "./bridge";

const providers: Provider[] = ["claude"];

export default function Command(props: LaunchProps<{ arguments: { frage?: string } }>) {
  return <AskView providers={providers} initialQuestion={props.arguments.frage || props.fallbackText} />;
}
