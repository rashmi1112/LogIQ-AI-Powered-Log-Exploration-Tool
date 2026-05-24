"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import type { Case, CaseFile } from "@prisma/client";
import { FileKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileDropzone, type DroppedFile } from "@/components/file-dropzone";
import {
  FileSpreadsheet,
  FileJson,
  FileText,
  Plus,
  Trash2,
  CircleAlert,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { formatBytes } from "@/lib/utils";

interface FilesPanelProps {
  caseRecord: Case;
  files: CaseFile[];
  onFilesChange: (files: CaseFile[]) => void;
}

function iconForKind(filename: string, kind: FileKind) {
  if (kind === FileKind.LOG)
    return <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />;
  if (kind === FileKind.MANIFEST || filename.toLowerCase().endsWith(".json"))
    return <FileJson className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />;
  return <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />;
}

export function FilesPanel({ caseRecord, files, onFilesChange }: FilesPanelProps) {
  const router = useRouter();
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [pending, setPending] = React.useState<DroppedFile[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const logs = files.filter((f) => f.kind === FileKind.LOG);
  const context = files.filter((f) => f.kind === FileKind.CONTEXT);
  const manifest = files.find((f) => f.kind === FileKind.MANIFEST);

  async function uploadFiles() {
    if (!pending.length) return;
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of pending) form.append("files", f.file, f.file.name);
      const res = await fetch(`/api/cases/${caseRecord.id}/files`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Upload failed");
      }
      const { files: created } = (await res.json()) as { files: CaseFile[] };
      onFilesChange([...files, ...created]);
      setPending([]);
      setUploadOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function deleteFile(fileId: string) {
    if (!confirm("Delete this file? This cannot be undone.")) return;
    const res = await fetch(`/api/cases/${caseRecord.id}/files/${fileId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      alert("Failed to delete file");
      return;
    }
    onFilesChange(files.filter((f) => f.id !== fileId));
    router.refresh();
  }

  return (
    <aside className="border-r bg-muted/20 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-sm">Bundle</h2>
          <p className="text-xs text-muted-foreground">{files.length} files</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {manifest && <ManifestCard caseRecord={caseRecord} file={manifest} onDelete={deleteFile} />}

          <FileSection
            title="Logs"
            kindLabel="CSV"
            files={logs}
            iconFn={(f) => iconForKind(f.filename, f.kind)}
            onDelete={deleteFile}
            emptyText="No log files yet"
          />

          <FileSection
            title="Context"
            kindLabel="TXT / JSON"
            files={context}
            iconFn={(f) => iconForKind(f.filename, f.kind)}
            onDelete={deleteFile}
            emptyText="No context artifacts yet"
          />
        </div>
      </ScrollArea>

      <Dialog open={uploadOpen} onOpenChange={(o) => !uploading && setUploadOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add files to this case</DialogTitle>
          </DialogHeader>
          <FileDropzone files={pending} onFilesChange={setPending} disabled={uploading} />
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setUploadOpen(false);
                setPending([]);
                setError(null);
              }}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button onClick={uploadFiles} disabled={uploading || !pending.length}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {uploading ? "Uploading..." : `Upload ${pending.length || ""}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function FileSection({
  title,
  kindLabel,
  files,
  iconFn,
  onDelete,
  emptyText,
}: {
  title: string;
  kindLabel: string;
  files: CaseFile[];
  iconFn: (f: CaseFile) => React.ReactNode;
  onDelete: (id: string) => void;
  emptyText: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <Badge variant="outline" className="text-[10px] font-mono">
          {files.length} · {kindLabel}
        </Badge>
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground italic px-1">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {files.map((f) => (
            <li
              key={f.id}
              className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-background transition"
            >
              {iconFn(f)}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{f.filename}</p>
                <p className="text-[10px] text-muted-foreground">{formatBytes(f.size)}</p>
              </div>
              <button
                onClick={() => onDelete(f.id)}
                className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition"
                title="Delete file"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ManifestCard({
  caseRecord,
  file,
  onDelete,
}: {
  caseRecord: Case;
  file: CaseFile;
  onDelete: (id: string) => void;
}) {
  const hasMeta = !!(caseRecord.caseId || caseRecord.jobId || caseRecord.catalog);
  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <FileJson className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="text-xs font-semibold flex-1 truncate">{file.filename}</span>
        <Badge variant="success" className="text-[10px]">
          <CheckCircle2 className="h-3 w-3 mr-1" /> Manifest
        </Badge>
        <button
          onClick={() => onDelete(file.id)}
          className="text-muted-foreground hover:text-destructive transition"
          title="Delete manifest"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {hasMeta ? (
        <dl className="text-xs space-y-1 pt-1 border-t">
          {caseRecord.caseId && (
            <MetaRow label="Case ID" value={caseRecord.caseId} mono />
          )}
          {caseRecord.jobId && <MetaRow label="Job ID" value={caseRecord.jobId} mono />}
          {caseRecord.catalog && <MetaRow label="Catalog" value={caseRecord.catalog} />}
          {caseRecord.hypervisor && (
            <MetaRow label="Hypervisor" value={caseRecord.hypervisor} mono />
          )}
          {caseRecord.failedMachines.length > 0 && (
            <div className="pt-1.5">
              <dt className="text-muted-foreground text-[10px] uppercase tracking-wide mb-1">
                Failed machines ({caseRecord.failedMachines.length})
              </dt>
              <dd className="flex flex-wrap gap-1">
                {caseRecord.failedMachines.slice(0, 10).map((m) => (
                  <Badge key={m} variant="outline" className="text-[10px] font-mono">
                    {m}
                  </Badge>
                ))}
                {caseRecord.failedMachines.length > 10 && (
                  <Badge variant="outline" className="text-[10px]">
                    +{caseRecord.failedMachines.length - 10}
                  </Badge>
                )}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <CircleAlert className="h-3 w-3" /> Manifest found but metadata could not be parsed.
        </p>
      )}
      <Separator />
      <p className="text-[10px] text-muted-foreground italic">
        Manifest defines scope — LogIQ filters logs to the files listed in it.
      </p>
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-muted-foreground text-[10px] uppercase tracking-wide w-20 shrink-0">
        {label}
      </dt>
      <dd className={`flex-1 truncate ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
