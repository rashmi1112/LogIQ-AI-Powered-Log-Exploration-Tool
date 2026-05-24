import { NewCaseForm } from "./new-case-form";

export default function NewCasePage() {
  return (
    <div className="container max-w-3xl py-8 md:py-12">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">New investigation</h1>
        <p className="text-muted-foreground mt-1">
          Name the case, then upload logs and context. If your bundle contains an investigation
          manifest, LogIQ will auto-detect it and populate metadata.
        </p>
      </div>
      <NewCaseForm />
    </div>
  );
}
