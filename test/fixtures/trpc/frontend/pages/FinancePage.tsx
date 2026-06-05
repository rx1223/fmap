import { trpc } from "../trpc";

export function FinancePage({ storeId }: { storeId: string }) {
  const { data } = trpc.store.revenue.today.useQuery({ storeId });
  return <div>{data?.amount}</div>;
}
