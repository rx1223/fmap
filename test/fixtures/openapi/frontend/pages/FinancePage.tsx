// fetch with a base path + an interpolated segment → GET /stores/{storeId}/revenue/today
export function FinancePage({ storeId }: { storeId: string }) {
  const load = () => fetch(`/api/stores/${storeId}/revenue/today`).then((r) => r.json());
  return <button onClick={load}>Load revenue</button>;
}
