"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import type { Case, CaseFile, Message } from "@prisma/client";
import { FilesPanel } from "./files-panel";
import { ChatPanel } from "./chat-panel";

type CaseWithRelations = Case & {
  files: CaseFile[];
  messages: Message[];
};

export function WorkspaceShell({ caseRecord }: { caseRecord: CaseWithRelations }) {
  const router = useRouter();
  const [files, setFiles] = React.useState<CaseFile[]>(caseRecord.files);

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-[340px_1fr] min-h-0">
      <FilesPanel
        caseRecord={caseRecord}
        files={files}
        onFilesChange={(next) => {
          setFiles(next);
          router.refresh();
        }}
      />
      <ChatPanel
        caseId={caseRecord.id}
        hasFiles={files.length > 0}
        initialMessages={caseRecord.messages}
      />
    </div>
  );
}
