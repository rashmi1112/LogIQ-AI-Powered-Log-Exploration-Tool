# LogIQ  
**Context-aware log investigation for production systems**

LogIQ is a lightweight investigation tool that helps engineers analyze large volumes of production logs **together with contextual artifacts** (Jira tickets, customer notes, runbooks, triage summaries).

Instead of scanning logs in isolation, LogIQ treats an incident as a **case workspace** with:
- scoped log files
- authoritative metadata (manifest)
- human-written context
- evidence-backed analysis

The goal is not to replace debugging, but to **reduce time-to-insight** during complex investigations.

---

## Why LogIQ exists

In real production incidents, engineers rarely work with logs alone.

A typical investigation includes:
- multiple log files from different services
- a job or case identifier
- failed machines or resources
- customer case notes
- internal runbooks
- partial triage summaries

These pieces usually live in different tools and require a lot of manual correlation.

**LogIQ brings them together into a single workflow** and helps surface:
- what happened
- where it likely failed
- what evidence supports each hypothesis
- what to check next

---

## What LogIQ does (MVP)

- Loads multiple CSV log files with a shared trace schema
- Ingests contextual artifacts (TXT / JSON)
- Uses an investigation manifest to define scope and metadata
- Automatically filters and prioritizes relevant log lines per question
- Produces structured, evidence-backed analysis with citations
- Supports iterative questioning via a chat interface (Streamlit UI)

---

## What LogIQ intentionally does *not* do (yet)

- No real-time log ingestion
- No vector database or embeddings
- No authentication / multi-tenant support
- No UI-heavy dashboards

This is a **focused investigation tool**, not a monitoring platform.

---

## Project structure

```text
logiq/
├── logiq.py                  # CLI entry point
├── logiq_core.py             # Core analysis logic (importable)
├── app.py                    # Streamlit UI (chat interface)
├── requirements.txt
├── logs/                     # CSV log files (per case)
│   ├── studio_console.log.csv
│   ├── broker_service.log.csv
│   ├── cloud_connector_proxy.log.csv
│   └── ...
├── context/                  # Contextual artifacts
│   ├── context_investigation_manifest.json
│   ├── context_jira_issue_summary.txt
│   ├── context_customer_case_notes.txt
│   └── ...
└── README.md
```
---

## Investigation manifest

LogIQ uses a **manifest file** to anchor each investigation.

The manifest defines:
- `case_id` / `job_id`
- catalog or workload
- affected machines
- which log files are in scope
- which context artifacts apply

### Example

```json
{
  "case_id": "HELP-537",
  "job_id": "JOB-510F2F1B",
  "catalog": "Win11-Office-VDI",
  "failed_machines": ["VM07", "VM12", "VM18"],
  "log_files": [
    "broker_service.log.csv",
    "cloud_connector_proxy.log.csv"
  ],
  "context_files": [
    "context_jira_issue_summary.txt",
    "context_triage_summary.txt"
  ]
}
```

When present, the manifest is treated as authoritative scope:

- Only listed logs are analyzed

- Missing or extra artifacts are explicitly called out

- Analysis stays grounded and reproducible

## How the analysis works (high level)

1. **Load workspace**
   - Logs
   - Context artifacts
   - Manifest metadata

2. **Scope validation**
   - Check logs and context against the manifest
   - Flag missing or unexpected files

3. **Retrieval-lite filtering**
   - Prioritize error, timeout, exception, and trace-related lines
   - Bias toward logs relevant to the current question
   - Cap total lines to keep analysis focused

4. **Structured reasoning**
   - Summarize what happened
   - Build a timeline
   - Propose hypotheses with supporting evidence
   - Recommend next actions

## Running LogIQ (CLI)

### Install dependencies

```bash
pip install -r requirements.txt
```

## Set API key

```bash
export OPENAI_API_KEY=your_key_here
```

## Run an investigation

```bash
python logiq.py \
  --logs ./logs \
  --context ./context \
  --question "Summarize what happened and what likely caused the provisioning failure."
```

## Design principles

- **Scope first** — every investigation is explicitly bounded
- **Evidence over speculation** — claims are tied to log lines
- **Human-in-the-loop** — engineers drive questions and interpretation
- **Simple before clever** — no unnecessary infrastructure

---

## Potential extensions

- Time-window filtering in the UI
- Evidence panel showing selected log lines
- Export investigation reports (Markdown / PDF)
- Pluggable parsers for different log schemas
- Optional embeddings for very large cases

---

## Disclaimer

LogIQ is a **portfolio and exploration project** built using synthetic or anonymized data.  
It is not affiliated with any specific vendor or production environment.




