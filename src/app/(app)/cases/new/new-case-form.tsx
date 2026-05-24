"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FileDropzone, type DroppedFile } from "@/components/file-dropzone";
import { ArrowRight, Loader2 } from "lucide-react";

export function NewCaseForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [files, setFiles] = React.useState<DroppedFile[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Please name your case");
      return;
    }

    setSubmitting(true);
    setProgress("Creating case...");

    try {
      const createRes = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      if (!createRes.ok) {
        const body = (await createRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to create case");
      }
      const { case: created } = (await createRes.json()) as { case: { id: string } };

      if (files.length) {
        setProgress(`Uploading ${files.length} ${files.length === 1 ? "file" : "files"}...`);
        const form = new FormData();
        for (const f of files) form.append("files", f.file, f.file.name);
        const uploadRes = await fetch(`/api/cases/${created.id}/files`, {
          method: "POST",
          body: form,
        });
        if (!uploadRes.ok) {
          const body = (await uploadRes.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Failed to upload files");
        }
      }

      setProgress("Opening workspace...");
      router.push(`/cases/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
      setProgress(null);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card className="p-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Case name *</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. HELP-537 — MCS provisioning failures"
            disabled={submitting}
            required
            maxLength={200}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="description">
            Description <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's the symptom? What are you trying to find out?"
            disabled={submitting}
            maxLength={2000}
            rows={3}
          />
        </div>
      </Card>

      <Card className="p-6">
        <div className="mb-4">
          <h2 className="font-semibold">Bundle</h2>
          <p className="text-sm text-muted-foreground">
            Upload CSV logs, plus any context (Jira summaries, runbooks, customer notes) and an
            optional investigation manifest JSON.
          </p>
        </div>
        <FileDropzone files={files} onFilesChange={setFiles} disabled={submitting} />
      </Card>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {progress ?? "You can add more files later from the workspace."}
        </p>
        <Button type="submit" disabled={submitting || !name.trim()} size="lg">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          {submitting ? "Working..." : "Create case"}
        </Button>
      </div>
    </form>
  );
}
