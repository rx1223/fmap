// Dynamic request URL — unambiguously HTTP (fetch) but the URL isn't static,
// so it must be reported UNRESOLVED, never force-matched.
export function MessyWidget({ url }: { url: string }) {
  const load = () => fetch(url).then((r) => r.json());
  return null;
}
