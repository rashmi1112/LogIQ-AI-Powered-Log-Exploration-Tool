import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handleApiError, requireUser } from "@/lib/api";

const CreateCaseSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

export async function GET() {
  try {
    const user = await requireUser();
    const cases = await prisma.case.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        caseId: true,
        jobId: true,
        catalog: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { files: true, messages: true } },
      },
    });
    return NextResponse.json({ cases });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = CreateCaseSchema.parse(await req.json());

    const c = await prisma.case.create({
      data: {
        userId: user.id,
        name: body.name,
        description: body.description,
      },
    });
    return NextResponse.json({ case: c }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
