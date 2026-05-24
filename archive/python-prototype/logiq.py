import argparse
import json
import os
import re
from pathlib import Path
from typing import List, Dict, Optional, Tuple

import pandas as pd
from dotenv import load_dotenv
from openai import OpenAI


# Expected trace schema
TIME_COL = "Time"          # timestamp
CPU_COL = "CPU"            # optional
MSG_COL = "Message"
COMMENTS_COL = "Comments"
LEVEL_COL = "Level"

DEFAULT_MAX_ROWS = 1200
DEFAULT_ERROR_ROWS = 450
DEFAULT_STACK_ROWS = 250
DEFAULT_RECENT_ROWS = 350
DEFAULT_CONTEXT_CHARS = 14000


# Manifest schema (your format)
MANIFEST_LOG_KEYS = ("log_files", "logs", "logFiles", "log_file_list")
MANIFEST_CONTEXT_KEYS = ("context_files", "context", "contextFiles", "context_file_list")


def normalize_filename(name: str) -> str:
    return name.replace("\\", "/").strip().lower()


def _first_list(payload: dict, keys: Tuple[str, ...]) -> List[str]:
    for k in keys:
        v = payload.get(k)
        if isinstance(v, list):
            return [str(x) for x in v]
    return []


def looks_like_manifest(filename: str, payload: dict) -> bool:
    # Light heuristic: filename OR presence of core fields
    fn = filename.lower()
    if "manifest" in fn:
        return True

    has_ids = any(k in payload for k in ("case_id", "job_id", "catalog"))
    has_lists = bool(_first_list(payload, MANIFEST_LOG_KEYS)) or bool(_first_list(payload, MANIFEST_CONTEXT_KEYS))
    return has_ids and has_lists


def extract_manifest_lists(payload: dict) -> Dict[str, List[str]]:
    logs = [normalize_filename(x) for x in _first_list(payload, MANIFEST_LOG_KEYS)]
    ctx = [normalize_filename(x) for x in _first_list(payload, MANIFEST_CONTEXT_KEYS)]
    return {"log_files_norm": logs, "context_files_norm": ctx}


def manifest_to_text(payload: dict) -> str:
    # Short and readable; enough to anchor scope + metadata
    lines = ["Manifest summary:"]

    for k in ["case_id", "job_id", "catalog", "hypervisor"]:
        if k in payload:
            lines.append(f"- {k}: {payload.get(k)}")

    if "failed_machines" in payload:
        fm = payload.get("failed_machines")
        if isinstance(fm, list):
            preview = ", ".join(map(str, fm[:20]))
            lines.append(f"- failed_machines: {len(fm)} -> {preview}" + (" ..." if len(fm) > 20 else ""))
        else:
            lines.append(f"- failed_machines: {fm}")

    logs = _first_list(payload, MANIFEST_LOG_KEYS)
    ctx = _first_list(payload, MANIFEST_CONTEXT_KEYS)

    if logs:
        lines.append(f"- log_files: {len(logs)}")
        for f in logs[:50]:
            lines.append(f"  - {f}")
        if len(logs) > 50:
            lines.append("  - ...")

    if ctx:
        lines.append(f"- context_files: {len(ctx)}")
        for f in ctx[:50]:
            lines.append(f"  - {f}")
        if len(ctx) > 50:
            lines.append("  - ...")

    # Include small extra fields if present (avoid dumping huge blobs)
    core = {"case_id", "job_id", "catalog", "hypervisor", "failed_machines", "log_files", "context_files"}
    extras = [k for k in payload.keys() if k not in core]
    if extras:
        lines.append("- other_metadata:")
        for k in extras[:25]:
            v = payload.get(k)
            s = str(v)
            if len(s) > 240:
                s = s[:240] + " …"
            lines.append(f"  - {k}: {s}")
        if len(extras) > 25:
            lines.append("  - ...")

    return "\n".join(lines)


def read_context_artifacts(context_dir: Path) -> Tuple[List[Dict[str, str]], Optional[Dict]]:
    """
    Loads .txt and .json context artifacts.
    If a JSON file looks like a manifest, treat it separately.
    """
    context_items: List[Dict[str, str]] = []
    manifest: Optional[Dict] = None

    for p in sorted(list(context_dir.glob("*.txt")) + list(context_dir.glob("*.json"))):
        if p.suffix.lower() == ".txt":
            txt = p.read_text(encoding="utf-8", errors="ignore").strip()
            context_items.append({"filename": p.name, "type": "text", "text": txt})
            continue

        raw = p.read_text(encoding="utf-8", errors="ignore").strip()
        try:
            payload = json.loads(raw) if raw else {}
        except Exception:
            context_items.append({"filename": p.name, "type": "text", "text": raw})
            continue

        if isinstance(payload, dict) and looks_like_manifest(p.name, payload) and manifest is None:
            lists = extract_manifest_lists(payload)
            manifest = {
                "filename": p.name,
                "payload": payload,
                "text": manifest_to_text(payload),
                "log_files_norm": lists["log_files_norm"],
                "context_files_norm": lists["context_files_norm"],
            }
        else:
            context_items.append({"filename": p.name, "type": "json", "text": json.dumps(payload, indent=2)})

    return context_items, manifest


def validate_manifest(manifest: Optional[Dict], logs_dir: Path, context_dir: Path) -> str:
    """
    Quick sanity check so we don't silently analyze the wrong set of files.
    """
    if not manifest:
        return ""

    lines = ["Manifest check:"]

    # Logs
    wanted_logs = set(Path(x).name.lower() for x in manifest.get("log_files_norm", []))
    actual_logs = set(p.name.lower() for p in logs_dir.glob("*.csv"))

    if wanted_logs:
        missing_logs = sorted([x for x in wanted_logs if x not in actual_logs])
        extra_logs = sorted([x for x in actual_logs if x not in wanted_logs])

        if not missing_logs and not extra_logs:
            lines.append("- logs: match manifest")
        else:
            if missing_logs:
                lines.append(f"- logs missing: {len(missing_logs)}")
                for m in missing_logs[:20]:
                    lines.append(f"  - {m}")
                if len(missing_logs) > 20:
                    lines.append("  - ...")
            if extra_logs:
                lines.append(f"- logs extra: {len(extra_logs)}")
                for e in extra_logs[:20]:
                    lines.append(f"  - {e}")
                if len(extra_logs) > 20:
                    lines.append("  - ...")

    # Context files
    wanted_ctx = set(Path(x).name.lower() for x in manifest.get("context_files_norm", []))
    actual_ctx = set(p.name.lower() for p in list(context_dir.glob("*.txt")) + list(context_dir.glob("*.json")))

    if wanted_ctx:
        missing_ctx = sorted([x for x in wanted_ctx if x not in actual_ctx])
        extra_ctx = sorted([x for x in actual_ctx if x not in wanted_ctx])

        if not missing_ctx and not extra_ctx:
            lines.append("- context: match manifest")
        else:
            if missing_ctx:
                lines.append(f"- context missing: {len(missing_ctx)}")
                for m in missing_ctx[:20]:
                    lines.append(f"  - {m}")
                if len(missing_ctx) > 20:
                    lines.append("  - ...")
            if extra_ctx:
                lines.append(f"- context extra: {len(extra_ctx)}")
                for e in extra_ctx[:20]:
                    lines.append(f"  - {e}")
                if len(extra_ctx) > 20:
                    lines.append("  - ...")

    return "\n".join(lines)


def read_log_csvs(logs_dir: Path, manifest: Optional[Dict], filter_by_manifest: bool = True) -> pd.DataFrame:
    csv_files = sorted(logs_dir.glob("*.csv"))
    if not csv_files:
        raise FileNotFoundError(f"No CSV files found in {logs_dir}")

    if filter_by_manifest and manifest and manifest.get("log_files_norm"):
        wanted = set(Path(x).name.lower() for x in manifest["log_files_norm"])
        filtered = [p for p in csv_files if p.name.lower() in wanted]
        if filtered:
            csv_files = filtered

    frames = []
    for p in csv_files:
        try:
            df = pd.read_csv(p, dtype=str, encoding="utf-8", errors="ignore")
        except Exception:
            df = pd.read_csv(p, dtype=str, encoding_errors="ignore")

        df["source_file"] = p.name
        df.columns = [c.strip() for c in df.columns]

        for col in [TIME_COL, MSG_COL, COMMENTS_COL, LEVEL_COL, CPU_COL]:
            if col not in df.columns:
                df[col] = ""

        frames.append(df)

    all_df = pd.concat(frames, ignore_index=True)

    all_df["ts"] = all_df[TIME_COL].fillna("").astype(str).str.strip()
    all_df["ts_parsed"] = pd.to_datetime(all_df["ts"], errors="coerce", utc=True)

    all_df["message"] = all_df[MSG_COL].fillna("").astype(str)
    all_df["comments"] = all_df[COMMENTS_COL].fillna("").astype(str)
    all_df["level"] = all_df[LEVEL_COL].fillna("").astype(str)
    all_df["cpu"] = all_df[CPU_COL].fillna("").astype(str)

    all_df["_row_id"] = range(len(all_df))
    all_df = all_df.sort_values(by=["ts_parsed", "_row_id"], na_position="last").reset_index(drop=True)

    for c in ["Module", "Src", "Function", "Class"]:
        if c not in all_df.columns:
            all_df[c] = ""
    all_df["module"] = all_df["Module"].fillna("").astype(str)

    return all_df


TRACE_RE = re.compile(r"(trace[-_ ]?id|correlation[-_ ]?id|request[-_ ]?id)\s*[:=]\s*([A-Za-z0-9\-_.]+)", re.IGNORECASE)
STACK_HINT_RE = re.compile(r"(Exception|StackTrace|at\s+[A-Za-z0-9_.]+\(|System\.)")


def pick_relevant_rows(df: pd.DataFrame, question: str,
                       max_rows: int = DEFAULT_MAX_ROWS,
                       err_rows: int = DEFAULT_ERROR_ROWS,
                       stack_rows: int = DEFAULT_STACK_ROWS,
                       recent_rows: int = DEFAULT_RECENT_ROWS) -> pd.DataFrame:
    q = (question or "").lower()
    keywords = [w for w in re.split(r"[^a-zA-Z0-9_]+", q) if len(w) >= 4]
    keywords = list(dict.fromkeys(keywords))[:18]

    def row_score(row) -> int:
        text = f"{row.get('message','')} {row.get('comments','')} {row.get('module','')}".lower()
        return sum(1 for k in keywords if k in text)

    lvl = df["level"].fillna("").str.upper()
    is_errorish = (
        lvl.str.contains("ERROR|FATAL|WARN", regex=True)
        | df["message"].str.contains("error|fail|timeout|exception", case=False, na=False)
        | df["comments"].str.contains("error|fail|timeout|exception", case=False, na=False)
    )

    is_stackish = (
        df["comments"].str.contains(TRACE_RE, na=False)
        | df["comments"].str.contains(STACK_HINT_RE, na=False)
        | df["message"].str.contains("Exception|StackTrace|timeout", case=False, na=False)
    )

    recent = df.tail(recent_rows)

    err_df = df[is_errorish].copy()
    if not err_df.empty:
        err_df["score"] = err_df.apply(row_score, axis=1)
        err_df = err_df.sort_values(["score", "ts_parsed", "_row_id"], ascending=[False, True, True]).head(err_rows)
    else:
        err_df = df.head(0)

    stk_df = df[is_stackish].copy()
    if not stk_df.empty:
        stk_df["score"] = stk_df.apply(row_score, axis=1)
        stk_df = stk_df.sort_values(["score", "ts_parsed", "_row_id"], ascending=[False, True, True]).head(stack_rows)
    else:
        stk_df = df.head(0)

    kw_df = df.copy()
    if keywords:
        kw_df["score"] = kw_df.apply(row_score, axis=1)
        kw_df = kw_df[kw_df["score"] > 0].sort_values(["score", "ts_parsed", "_row_id"], ascending=[False, True, True]).head(250)
    else:
        kw_df = df.head(0)

    combined = pd.concat([recent, err_df, stk_df, kw_df], ignore_index=True)
    combined = combined.drop_duplicates(subset=["source_file", "_row_id"]).sort_values(
        by=["ts_parsed", "_row_id"], na_position="last"
    )

    return combined.tail(max_rows)


def format_rows_for_prompt(df: pd.DataFrame) -> str:
    lines = []
    for _, r in df.iterrows():
        ts = (r.get("ts") or "").strip()
        src = r.get("source_file", "")
        lvl = (r.get("level") or "").strip()
        module = (r.get("module") or "").strip()
        cpu = (r.get("cpu") or "").strip()
        msg = (r.get("message") or "").strip()
        cmt = (r.get("comments") or "").strip()

        if len(cmt) > 500:
            cmt = cmt[:500] + " …"

        line = f"[{src}] [{ts}] [{lvl}] [{module}]"
        if cpu:
            line += f" [CPU={cpu}]"
        line += f" msg={msg}"
        if cmt:
            line += f" | comments={cmt}"
        lines.append(line)

    return "\n".join(lines)


def build_context_blob(items: List[Dict[str, str]], max_chars: int = DEFAULT_CONTEXT_CHARS) -> str:
    parts = []
    total = 0
    for it in items:
        header = f"\n--- {it['filename']} ---\n"
        body = (it["text"] or "").strip()
        chunk = header + body + "\n"
        if total + len(chunk) > max_chars:
            remaining = max(0, max_chars - total)
            if remaining > len(header) + 50:
                parts.append(header + body[: remaining - len(header)] + "\n...\n")
            break
        parts.append(chunk)
        total += len(chunk)
    return "".join(parts).strip()


SYSTEM_PROMPT = """You are helping debug a production issue using logs and attached artifacts.

Guidelines:
- When a manifest is present, use it for scope/metadata.
- Prefer evidence over speculation. If uncertain, say what would confirm it.
- Do not invent details not supported by the provided data.
- Include citations using the provided log line prefixes (e.g., [file.csv] [timestamp] ...).
"""

USER_PROMPT_TEMPLATE = """Question:
{question}

Manifest:
{manifest_block}

{manifest_validation}

Context:
{context_blob}

Logs (citeable lines):
{log_blob}

Respond with:
1) Summary (3-5 bullets)
2) Scope (based on manifest; note missing/extra if relevant)
3) Timeline (5-12 key events with citations)
4) Hypotheses (2-4) with evidence + how to confirm/deny
5) Recommended next actions (prioritized)
6) Additional artifacts that would increase confidence
"""


def ask_openai(question: str, manifest_block: str, manifest_validation: str, context_blob: str, log_blob: str,
               model: str = "gpt-4.1-mini", temperature: float = 0.2) -> str:
    client = OpenAI()
    user_prompt = USER_PROMPT_TEMPLATE.format(
        question=question.strip(),
        manifest_block=manifest_block.strip(),
        manifest_validation=(manifest_validation or "").strip(),
        context_blob=context_blob.strip(),
        log_blob=log_blob.strip(),
    )
    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    )
    return resp.choices[0].message.content


def main():
    load_dotenv()

    ap = argparse.ArgumentParser(description="LogIQ MVP (CLI)")
    ap.add_argument("--logs", required=True, help="Directory with CSV logs")
    ap.add_argument("--context", required=True, help="Directory with TXT/JSON context artifacts")
    ap.add_argument("--question", required=True, help="Investigation question")
    ap.add_argument("--model", default=os.getenv("LOGIQ_MODEL", "gpt-4.1-mini"), help="OpenAI model name")
    ap.add_argument("--max_rows", type=int, default=DEFAULT_MAX_ROWS, help="Max log lines to send")
    ap.add_argument("--temperature", type=float, default=0.2, help="Sampling temperature")
    ap.add_argument("--no_manifest_filter", action="store_true",
                    help="Do not filter /logs by manifest log_files (still uses manifest metadata)")
    args = ap.parse_args()

    logs_dir = Path(args.logs)
    ctx_dir = Path(args.context)

    context_items, manifest = read_context_artifacts(ctx_dir)

    if manifest:
        manifest_block = manifest["text"]
        manifest_validation = validate_manifest(manifest, logs_dir, ctx_dir)
        if manifest_validation:
            manifest_validation = "\n" + manifest_validation + "\n"
    else:
        manifest_block = "(not provided)"
        manifest_validation = ""

    df = read_log_csvs(
        logs_dir,
        manifest=manifest,
        filter_by_manifest=(not args.no_manifest_filter),
    )

    selected = pick_relevant_rows(df, args.question, max_rows=args.max_rows)
    log_blob = format_rows_for_prompt(selected)
    context_blob = build_context_blob(context_items)

    if not os.getenv("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY is not set")

    answer = ask_openai(
        args.question,
        manifest_block=manifest_block,
        manifest_validation=manifest_validation,
        context_blob=context_blob,
        log_blob=log_blob,
        model=args.model,
        temperature=args.temperature,
    )
    print(answer)


if __name__ == "__main__":
    main()

