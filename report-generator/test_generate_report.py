"""Regression coverage for the standalone DOCX telemetry report generator."""

import subprocess
import sys
from pathlib import Path

from docx import Document


ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "generate_report.py"
FIXTURE = ROOT / "sample_data" / "sample_report_input.json"


def test_docx_report_contains_expected_sections(tmp_path: Path) -> None:
    output_path = tmp_path / "sample_report.docx"
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--input", str(FIXTURE),
            "--output", str(output_path),
            "--format", "docx",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert output_path.exists()
    assert output_path.stat().st_size > 0

    document = Document(output_path)
    text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    for heading in (
        "Executive Summary",
        "Key Metrics",
        "Insights",
        "Anomalies",
        "Recommendations",
        "Window-by-Window Detail",
    ):
        assert heading in text
