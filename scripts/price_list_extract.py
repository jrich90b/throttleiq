#!/usr/bin/env python3
import sys
from pathlib import Path

def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/price_list_extract.py /path/to/price_list.pdf [output.txt]")
        return 1

    pdf_path = Path(sys.argv[1]).expanduser().resolve()
    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}")
        return 1

    out_path = (
        Path(sys.argv[2]).expanduser().resolve()
        if len(sys.argv) > 2
        else Path("data/price_list_raw.txt").resolve()
    )

    try:
        from pypdf import PdfReader  # type: ignore
    except Exception:
        print("Missing dependency: pypdf. Install with: python3 -m pip install pypdf")
        return 1

    reader = PdfReader(str(pdf_path))
    parts = []
    for i, page in enumerate(reader.pages):
        text = page.extract_text() or ""
        parts.append(f"\n\n===== PAGE {i + 1} =====\n\n{text}")

    out_path.write_text("\n".join(parts), encoding="utf-8")
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
