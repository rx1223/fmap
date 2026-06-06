// Multi-segment fetch against a catch-all route.
export function FilesPage({ id }: { id: string }) {
  const load = () => fetch(`/api/files/${id}/a/b.json`).then((r) => r.json());
  return <button onClick={load}>Load</button>;
}
