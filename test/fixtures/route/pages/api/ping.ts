// Next.js pages API → method unknown (ALL); a health/ping path → noise.
export default function handler(_req: unknown, res: { send: (s: string) => void }) {
  res.send("pong");
}
