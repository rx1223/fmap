import { useQuery } from "@apollo/client";
import { TODAY_REVENUE } from "../queries";

// Clean, high-confidence: named const imported from another file.
export function FinancePage() {
  const { data } = useQuery(TODAY_REVENUE, { variables: { storeId: "1" } });
  return <div>{data?.todayRevenue?.amount}</div>;
}
