// fetch with an explicit method option → POST /cards/trial
export function CardPage() {
  const buy = () => fetch("/api/cards/trial", { method: "POST" });
  return <button onClick={buy}>Buy trial card</button>;
}
