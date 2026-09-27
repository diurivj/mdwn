import { useParams } from "react-router";
import { FilesWorkspace } from "~/tree/FilesWorkspace";

export function meta() { return [{ title: "Files — mdwn" }]; }
export default function DirectoryRoute() {
  const { directoryId } = useParams();
  return <FilesWorkspace nodeId={directoryId ?? ""} kind="directory" />;
}
