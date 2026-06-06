// Next.js catch-all route → GET /api/files/{...path} (matches multi-segment URLs)
export async function GET() {
  return Response.json([]);
}
