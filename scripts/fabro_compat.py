#!/usr/bin/env python3
"""fabro_compat.py — is a model compatible with Fabro agentic workflows?

`fabro model test --deep` only exercises one simple function tool, so it passes
models that then fail a real run (Perplexity rejects the freeform `custom`
apply_patch tool; sonar-* break streaming). This probe runs a minimal REAL Fabro
workflow that forces the agent to use its file tools, then checks the side
effect — the ground truth — instead of the run Status (which reports SUCCEEDED
even when every LLM node errored).

Usage:  python3 fabro_compat.py <model-id> [<model-id> ...]
Example: python3 fabro_compat.py gemini-3.1-flash-lite pplx/claude-haiku-4-5
Exit code: 0 if all requested models are compatible, 1 otherwise.
"""
import subprocess
import sys
import tempfile
import re
from pathlib import Path

WORKFLOW_DOT = """digraph FabroCompatProbe {{
    graph [
        goal="Fabro compatibility probe",
        model_stylesheet="* {{ model: {model}; }}"
    ]
    rankdir=LR
    start [shape=Mdiamond, label="Start"]
    exit  [shape=Msquare, label="Exit"]
    act [label="Act", prompt="Using your file-editing tools, create a file named compat_ok.txt in the current directory whose only contents are the single word: ok\\nThen read the file back and confirm it contains ok. Respond with the word done."]
    start -> act -> exit
}}"""

WORKFLOW_TOML = """_version = 1

[workflow]
graph = "workflow.fabro"

[run.environment]
id = "local"

[environments.local]
provider = "local"

[run.pull_request]
enabled = false
"""

# Map a raw failure line to a short human-readable requirement it violates.
FAILURE_HINTS = [
    (re.compile(r"unknown discriminator value: custom", re.I),
     "custom/freeform tools not supported (rejects apply_patch)"),
    (re.compile(r"Stream ended without a Finish event", re.I),
     "streaming does not emit a Finish event"),
    (re.compile(r"reasoning_effort", re.I),
     "rejects the reasoning_effort parameter"),
    (re.compile(r"Rate limited", re.I),
     "rate limited (not viable for sustained agentic use)"),
    (re.compile(r"Tool calling is not supported", re.I),
     "does not support tool calling"),
    (re.compile(r"not registered|not configured", re.I),
     "provider not configured on the server"),
    (re.compile(r"Authentication error|invalid x-api-key|Unauthorized", re.I),
     "authentication rejected"),
]


def probe(model: str) -> tuple[bool, str]:
    """Run the probe workflow for `model`; return (compatible, detail)."""
    with tempfile.TemporaryDirectory(prefix="fabro-compat-") as d:
        work = Path(d)
        # Local sandbox works inside a git repo; init a throwaway one.
        subprocess.run(["git", "init", "-q"], cwd=work, check=False)
        wf_dir = work / ".fabro" / "workflows" / "compat"
        wf_dir.mkdir(parents=True)
        (wf_dir / "workflow.fabro").write_text(WORKFLOW_DOT.format(model=model))
        (wf_dir / "workflow.toml").write_text(WORKFLOW_TOML)

        proc = subprocess.run(
            ["fabro", "run", ".fabro/workflows/compat/workflow.toml",
             "--auto-approve", "--quiet", "--no-upgrade-check"],
            cwd=work, capture_output=True, text=True, timeout=300,
        )
        out = proc.stdout + proc.stderr
        # Ground truth: did the agent actually create the file via its tools?
        produced = (work / "compat_ok.txt").exists()
        if produced and "ok" in (work / "compat_ok.txt").read_text().lower():
            return True, "created compat_ok.txt via its tools"
        # Not compatible — classify the failure from the run output.
        for pat, hint in FAILURE_HINTS:
            if pat.search(out):
                return False, hint
        # No known signature — surface the first error line.
        err = next((ln.strip() for ln in out.splitlines()
                    if re.search(r"error|✗", ln, re.I)), "no file produced")
        return False, err[:160]


def main() -> int:
    models = sys.argv[1:] or ["gemini-3.1-flash-lite"]
    all_ok = True
    width = max(len(m) for m in models)
    print(f"{'MODEL':<{width}}  RESULT   DETAIL")
    for m in models:
        try:
            ok, detail = probe(m)
        except subprocess.TimeoutExpired:
            ok, detail = False, "timed out (300s)"
        except Exception as e:  # noqa: BLE001
            ok, detail = False, f"probe error: {e}"
        all_ok &= ok
        status = "PASS" if ok else "FAIL"
        print(f"{m:<{width}}  {status:<7}  {detail}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
