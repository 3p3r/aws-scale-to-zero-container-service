import { NextResponse } from "next/server";

export async function GET() {
  // Return empty response for favicon requests
  return new NextResponse(null, { status: 204 });
}
