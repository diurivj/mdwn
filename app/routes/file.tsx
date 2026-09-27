import { useParams } from "react-router";
import { FilesWorkspace } from "~/tree/FilesWorkspace";

export function meta() { return [{ title: "Files — mdwn" }]; }
export default function FileRoute() {
  const { fileId } = useParams();
  return <FilesWorkspace nodeId={fileId ?? ""} kind="file" />;
}
