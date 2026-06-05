import { trpc } from "../trpc";

export function CardPage() {
  const buy = trpc.card.purchaseTrial.useMutation();
  return <button onClick={() => buy.mutate()}>Buy trial card</button>;
}
