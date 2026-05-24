import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 font-semibold", className)}>
      <div className="relative flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow">
        <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
          <path d="M4 6h11M4 12h11M4 18h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="19" cy="18" r="3" stroke="currentColor" strokeWidth="2" />
          <path d="m22 21-1.5-1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <span className="text-base tracking-tight">LogIQ</span>
    </div>
  );
}
