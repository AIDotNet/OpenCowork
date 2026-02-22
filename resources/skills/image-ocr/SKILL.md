---
name: image-ocr
description: Extract text from images using Python OCR. Use when the user wants to read text from screenshots, photos of documents, scanned pages, or any image containing text. Supports PNG, JPEG, TIFF, BMP, and WebP formats.
compatibility: Requires Python 3 and pytesseract + Pillow (pip install pytesseract Pillow). Also requires Tesseract OCR engine installed on the system.
---

# Image OCR

Extract text from images using Tesseract OCR via Python.

## When to use this skill

- User asks to read or extract text from an image
- User has a screenshot with text they want to process
- User has scanned documents that need text extraction
- User wants to digitize text from photos

## Scripts overview

| Script | Purpose | Dependencies |
|---|---|---|
| `ocr_extract.py` | Extract text from images with multiple options | `pytesseract`, `Pillow` |

## Steps

### 1. Install dependencies (first time only)

Install the Python packages:
```bash
pip install pytesseract Pillow
```

Install Tesseract OCR engine:
- **Windows**: Download installer from https://github.com/UB-Mannheim/tesseract/wiki
- **macOS**: `brew install tesseract`
- **Linux (Ubuntu/Debian)**: `sudo apt install tesseract-ocr`
- **Linux (Fedora)**: `sudo dnf install tesseract`

For additional language support:
- **Windows**: Select languages during installation
- **Linux**: `sudo apt install tesseract-ocr-chi-sim` (Chinese Simplified), `tesseract-ocr-jpn` (Japanese), etc.

> **CRITICAL — Dependency Error Recovery**: If the script fails with an `ImportError` or "tesseract not found" error, install the missing dependencies using the commands above, then **re-run the EXACT SAME script command that failed**.

### 2. Extract text from an image

```bash
python scripts/ocr_extract.py "IMAGE_PATH"
```

Options:
- `--lang LANG` — OCR language (default: `eng`). Use `chi_sim` for Chinese, `jpn` for Japanese, `eng+chi_sim` for multiple.
- `--save OUTPUT_PATH` — Save extracted text to a file
- `--preprocess MODE` — Image preprocessing: `none` (default), `grayscale`, `threshold`, `blur`
- `--dpi DPI` — Set image DPI for better accuracy (default: auto-detect)
- `--psm MODE` — Tesseract page segmentation mode (0-13, default: 3 = auto)

Examples:
```bash
# Basic text extraction
python scripts/ocr_extract.py "screenshot.png"

# Chinese text extraction
python scripts/ocr_extract.py "document.jpg" --lang chi_sim

# Mixed English and Chinese
python scripts/ocr_extract.py "mixed.png" --lang eng+chi_sim

# Preprocess noisy image for better accuracy
python scripts/ocr_extract.py "noisy_scan.png" --preprocess threshold

# Save output to file
python scripts/ocr_extract.py "scan.tiff" --save output.txt

# Single line of text (e.g., license plate, serial number)
python scripts/ocr_extract.py "plate.jpg" --psm 7
```

## Page Segmentation Modes (PSM)

| Mode | Description | Use Case |
|---|---|---|
| 3 | Fully automatic (default) | General documents |
| 4 | Assume single column | Single-column text |
| 6 | Assume single block | Uniform text block |
| 7 | Single line | One line of text |
| 8 | Single word | One word |
| 11 | Sparse text | Text scattered on image |
| 13 | Raw line | Single line, no OSD |

## Edge cases

- **Low quality images**: Use `--preprocess threshold` or `--preprocess blur` to improve results
- **Rotated text**: Tesseract handles slight rotation; for heavily rotated images, rotate first
- **Very small text**: Increase DPI with `--dpi 300` or higher
- **Mixed languages**: Combine with `+`, e.g., `--lang eng+chi_sim+jpn`
- **Empty results**: Try different PSM modes or preprocessing options

## Scripts

- [ocr_extract.py](scripts/ocr_extract.py) — Extract text from images using Tesseract OCR
