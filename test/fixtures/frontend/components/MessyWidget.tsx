import { useQuery, gql } from "@apollo/client";

// A registry the scanner can't statically index.
const QUERIES: Record<string, unknown> = {};

export function MessyWidget({ type, field }: { type: string; field: string }) {
  // Dynamic name — the scanner must NOT guess which resolver this is.
  const a = useQuery(QUERIES[type]);

  // Runtime-composed template — info doesn't exist before runtime → UNKNOWN.
  const b = useQuery(gql`
    query {
      ${field}
    }
  `);

  return null;
}
