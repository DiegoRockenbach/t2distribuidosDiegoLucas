"""Imprime relatorio/RELATORIO_FINAL.html em PDF com o Microsoft Edge (ou Chrome) headless.

Uso: .venv/Scripts/python.exe analysis/build_report.py
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "relatorio" / "RELATORIO_FINAL.html"
OUTPUT = ROOT / "relatorio" / "Relatorio_T2_Sistemas_Distribuidos_Lucas_Aued_Diego_Rockenbach.pdf"
BROWSERS = [
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
]


def main() -> None:
    browser = next((path for path in BROWSERS if path.exists()), None)
    if browser is None:
        found = shutil.which("msedge") or shutil.which("chrome")
        browser = Path(found) if found else None
    if browser is None:
        raise SystemExit("Edge/Chrome nao encontrado; abra o HTML no navegador e imprima em PDF.")
    subprocess.run([str(browser), "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                    f"--print-to-pdf={OUTPUT}", SOURCE.resolve().as_uri()], check=True, timeout=120)
    print(f"PDF: {OUTPUT}")


if __name__ == "__main__":
    main()
