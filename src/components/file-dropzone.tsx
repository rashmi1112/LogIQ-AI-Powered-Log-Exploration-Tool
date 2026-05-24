"use client";
import * as React from "react";
import { Upload, X, FileText, FileJson, FileSpreadsheet } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";

const ACCEPT = ".csv,.txt,.json,.log";

export interface DroppedFile {
  file: File;
  id: string;
}

interface FileDropzoneProps {
  files: DroppedFile[];
  onFilesChange: (files: DroppedFile[]) => void;
  disabled?: boolean;
  className?: string;
}

function fileIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".log"))
    return <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
  if (lower.endsWith(".json"))
    return <FileJson className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
  return <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400" />;
}

export function FileDropzone({ files, onFilesChange, disabled, className }: FileDropzoneProps) {
  const [isDragging, setIsDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  function addFiles(incoming: FileList | File[]) {
    const list = Array.from(incoming);
    const existing = new Set(files.map((f) => `${f.file.name}:${f.file.size}`));
    const added: DroppedFile[] = [];
    for (const f of list) {
      const key = `${f.name}:${f.size}`;
      if (existing.has(key)) continue;
      existing.add(key);
      added.push({ file: f, id: `${key}:${Math.random().toString(36).slice(2)}` });
    }
    onFilesChange([...files, ...added]);
  }

  function removeFile(id: string) {
    onFilesChange(files.filter((f) => f.id !== id));
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (disabled) return;
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        className={cn(
          "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition",
          isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm font-medium mb-1">Drag and drop files, or click to browse</p>
        <p className="text-xs text-muted-foreground">
          CSV logs · context TXT or JSON · manifest JSON · up to 25 MB per file
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <div className="bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground border-b">
            {files.length} {files.length === 1 ? "file" : "files"} ready to upload
          </div>
          <ul className="divide-y">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                {fileIcon(f.file.name)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{f.file.name}</p>
                  <p className="text-xs text-muted-foreground">{formatBytes(f.file.size)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(f.id)}
                  disabled={disabled}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-50 transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
