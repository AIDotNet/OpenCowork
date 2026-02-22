#!/usr/bin/env python3
"""
Extract text from images using Tesseract OCR.
Dependencies: pytesseract, Pillow
System requirement: Tesseract OCR engine installed
"""

import argparse
import sys
import os

try:
    import pytesseract
    from PIL import Image, ImageFilter
except ImportError as e:
    print(f"Missing dependency: {e}", file=sys.stderr)
    print("Install with: pip install pytesseract Pillow", file=sys.stderr)
    print("Also install Tesseract OCR engine on your system.", file=sys.stderr)
    sys.exit(1)


def preprocess_image(img, mode):
    """Apply preprocessing to improve OCR accuracy."""
    if mode == 'grayscale':
        return img.convert('L')
    elif mode == 'threshold':
        gray = img.convert('L')
        return gray.point(lambda x: 0 if x < 128 else 255, '1')
    elif mode == 'blur':
        return img.filter(ImageFilter.MedianFilter(size=3))
    return img


def extract_text(image_path, lang='eng', preprocess='none', dpi=None, psm=3):
    """Extract text from an image file."""
    if not os.path.isfile(image_path):
        print(f"Error: File not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    try:
        img = Image.open(image_path)
    except Exception as e:
        print(f"Error opening image: {e}", file=sys.stderr)
        sys.exit(1)

    # Apply preprocessing
    if preprocess != 'none':
        img = preprocess_image(img, preprocess)

    # Build Tesseract config
    config_parts = [f'--psm {psm}']
    if dpi:
        config_parts.append(f'--dpi {dpi}')
    config = ' '.join(config_parts)

    try:
        text = pytesseract.image_to_string(img, lang=lang, config=config)
    except pytesseract.TesseractNotFoundError:
        print("Error: Tesseract OCR engine not found.", file=sys.stderr)
        print("Install it:", file=sys.stderr)
        print("  Windows: https://github.com/UB-Mannheim/tesseract/wiki", file=sys.stderr)
        print("  macOS:   brew install tesseract", file=sys.stderr)
        print("  Linux:   sudo apt install tesseract-ocr", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"OCR error: {e}", file=sys.stderr)
        sys.exit(1)

    return text.strip()


def main():
    parser = argparse.ArgumentParser(
        description='Extract text from images using Tesseract OCR'
    )
    parser.add_argument('image', help='Path to the image file')
    parser.add_argument(
        '--lang', default='eng',
        help='OCR language (default: eng). Examples: chi_sim, jpn, eng+chi_sim'
    )
    parser.add_argument(
        '--save', metavar='OUTPUT',
        help='Save extracted text to a file'
    )
    parser.add_argument(
        '--preprocess', default='none',
        choices=['none', 'grayscale', 'threshold', 'blur'],
        help='Image preprocessing mode (default: none)'
    )
    parser.add_argument(
        '--dpi', type=int, default=None,
        help='Set image DPI for better accuracy'
    )
    parser.add_argument(
        '--psm', type=int, default=3,
        help='Tesseract page segmentation mode 0-13 (default: 3 = auto)'
    )

    args = parser.parse_args()

    text = extract_text(
        args.image,
        lang=args.lang,
        preprocess=args.preprocess,
        dpi=args.dpi,
        psm=args.psm
    )

    if not text:
        print("(No text detected in image)", file=sys.stderr)
        print("Tips: try --preprocess threshold, different --psm mode, or --lang option",
              file=sys.stderr)
    else:
        print(text)

    if args.save:
        with open(args.save, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f"\nText saved to {args.save}", file=sys.stderr)


if __name__ == '__main__':
    main()
