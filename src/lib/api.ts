import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new ApiError(401, "Unauthorized");
  }
  return session.user;
}

export async function requireCaseOwnership(caseId: string, userId: string) {
  const c = await prisma.case.findUnique({
    where: { id: caseId },
    select: { id: true, userId: true },
  });
  if (!c) throw new ApiError(404, "Case not found");
  if (c.userId !== userId) throw new ApiError(403, "Forbidden");
  return c;
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("Unhandled API error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
