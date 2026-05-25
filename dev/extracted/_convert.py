"""Convert dev/*.pdf -> dev/extracted/*.md with OCR'd image sidecars.

Run from anywhere:
    python "C:\\Users\\Haipeng Wu\\Desktop\\cursor_for_hardware\\dev\\extracted\\_convert.py"
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

import fitz
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

sys.stdout.reconfigure(encoding="utf-8")

DEV_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = Path(__file__).resolve().parent
OUT_DIR.mkdir(exist_ok=True)

PDF_TO_SLUG = {
    "Thonny-uPyPi 包管理插件需求规格说明书.pdf": "thonny-upypi-需求规格",
    "Thonny中Mpy包管理器插件的安装和使用.pdf": "thonny-mpy-安装使用",
    "uPyStore-MicroPythonOS应用商城需求文档和背景介绍.pdf": "upystore-应用商城",
    "一句话生硬件-相关资料文档.pdf": "一句话生硬件-资料汇总",
    "开发_生产_宣传等规范和相关标准化SOP流程总结.pdf": "开发生产宣传SOP",
}

TITLES = {
    "thonny-upypi-需求规格": "Thonny-uPyPi 包管理插件需求规格说明书 — 插件功能/API/验收标准",
    "thonny-mpy-安装使用": "Thonny 中 Mpy 包管理器插件安装与使用 — 在线 + 离线安装教程",
    "upystore-应用商城": "uPyStore-MicroPythonOS 应用商城需求与背景 — V1/V2 功能 + 数据表",
    "一句话生硬件-资料汇总": "一句话生硬件 相关资料汇总 — 项目链接与上游仓库",
    "开发生产宣传SOP": "开发/生产/宣传 SOP 流程 — GraftSense 模块全流程",
}

URL_RE = re.compile(r"https?://[^\s)\]\}>'\"，。、；：（）【】《》「」]+", re.IGNORECASE)
GITHUB_RE = re.compile(r"https?://github\.com/", re.IGNORECASE)


def clean_url(u: str) -> str:
    # strip zero-width chars and trailing punctuation that the regex let through
    u = u.replace("​", "").replace("‌", "").replace("‍", "").replace("﻿", "")
    return u.rstrip(".,;:!?)]}'\"`-—– \t（）。，；：")

ocr_engine = RapidOCR()


def ocr_image(png_bytes: bytes) -> str:
    """Return OCR text concatenated with spaces. Empty string if nothing."""
    try:
        result, _ = ocr_engine(png_bytes)
    except Exception as e:
        return f"[OCR 失败: {e}]"
    if not result:
        return ""
    return " ".join((line[1] or "").strip() for line in result if line and line[1]).strip()


def extract_one(pdf_path: Path, slug: str) -> tuple[str, list[str]]:
    """Return (md_text, list_of_urls_found)."""
    img_dir = OUT_DIR / f"{slug}_images"
    img_dir.mkdir(exist_ok=True)

    doc = fitz.open(pdf_path)
    md_lines: list[str] = [f"# {pdf_path.stem}", "", f"> 源文件：`dev/{pdf_path.name}` · 共 {len(doc)} 页", ""]
    urls_found: list[str] = []
    img_counter_per_page: dict[int, int] = {}

    for pno, page in enumerate(doc, 1):
        md_lines.append(f"## 第 {pno} 页")
        md_lines.append("")

        # blocks: list of (x0,y0,x1,y1, content, block_no, block_type)
        # block_type: 0=text, 1=image
        blocks = page.get_text("blocks")
        blocks_sorted = sorted(blocks, key=lambda b: (round(b[1], 1), round(b[0], 1)))

        for b in blocks_sorted:
            x0, y0, x1, y1, content, bno, btype = b
            if btype == 0:  # text
                text = (content or "").strip()
                if not text:
                    continue
                # collect urls
                urls_found.extend(URL_RE.findall(text))
                md_lines.append(text)
                md_lines.append("")
            else:  # image block — but get_text doesn't give pixel bytes; we cross-ref via get_images
                pass

        # Now extract every image on this page, save and OCR; place after the page's text
        # (Mixing position perfectly with text is unreliable on flat scans — keep page-grouped.)
        imgs_on_page = page.get_images(full=True)
        for img_info in imgs_on_page:
            xref = img_info[0]
            try:
                base = doc.extract_image(xref)
            except Exception:
                continue
            img_bytes = base["image"]
            ext = base.get("ext", "png")

            # Probe size; skip tiny
            try:
                with Image.open(io.BytesIO(img_bytes)) as im:
                    w, h = im.size
                    if w < 30 or h < 30:
                        continue
                    # Normalize to PNG for consistent OCR + storage
                    if ext.lower() != "png":
                        buf = io.BytesIO()
                        im.convert("RGB").save(buf, format="PNG")
                        img_bytes = buf.getvalue()
                        ext = "png"
            except Exception:
                continue

            idx = img_counter_per_page.get(pno, 0) + 1
            img_counter_per_page[pno] = idx
            fname = f"p{pno:02d}-img{idx:02d}.png"
            (img_dir / fname).write_bytes(img_bytes)

            md_lines.append(f"![{fname}]({slug}_images/{fname})")
            md_lines.append("")

            ocr_text = ocr_image(img_bytes)
            if ocr_text:
                urls_found.extend(URL_RE.findall(ocr_text))
                # quote-block, escape newlines inside
                ocr_one_line = ocr_text.replace("\n", " ")
                md_lines.append(f"> **图片文字识别**：{ocr_one_line}")
                md_lines.append("")

        md_lines.append("")

    doc.close()
    return "\n".join(md_lines), urls_found


def main():
    all_urls: list[str] = []
    summaries: list[tuple[str, str]] = []  # (slug, title)

    for pdf_name, slug in PDF_TO_SLUG.items():
        pdf_path = DEV_DIR / pdf_name
        if not pdf_path.exists():
            print(f"[SKIP] missing: {pdf_path}")
            continue
        print(f"[CONVERT] {pdf_name} -> {slug}.md")
        md_text, urls = extract_one(pdf_path, slug)
        (OUT_DIR / f"{slug}.md").write_text(md_text, encoding="utf-8")
        all_urls.extend(urls)
        summaries.append((slug, TITLES[slug]))

    # INDEX.md
    cleaned = [clean_url(u) for u in all_urls]
    cleaned = [u for u in cleaned if len(u) > 10]
    github_urls = sorted({u for u in cleaned if GITHUB_RE.match(u)})
    other_urls = sorted({u for u in cleaned if not GITHUB_RE.match(u)})

    idx_lines = [
        "# dev/extracted 索引",
        "",
        "> 由 `dev/*.pdf` 转换而来，原 PDF 保留在 `dev/` 下未改动。",
        "> 转换日期：2026-05-25 · 工具：PyMuPDF + RapidOCR",
        "> 图片旁的 `> **图片文字识别**：…` 行是 OCR 结果，可被 grep 命中。",
        "",
        "## 文档列表",
        "",
    ]
    for i, (slug, title) in enumerate(summaries, 1):
        idx_lines.append(f"{i}. [{title}]({slug}.md)")
    idx_lines.append("")
    idx_lines.append("## GitHub 链接汇总")
    idx_lines.append("")
    if github_urls:
        for u in github_urls:
            idx_lines.append(f"- {u}")
    else:
        idx_lines.append("- （未发现 GitHub 链接）")
    idx_lines.append("")
    idx_lines.append("## 其他外链汇总")
    idx_lines.append("")
    if other_urls:
        for u in other_urls:
            idx_lines.append(f"- {u}")
    else:
        idx_lines.append("- （无）")
    idx_lines.append("")

    (OUT_DIR / "INDEX.md").write_text("\n".join(idx_lines), encoding="utf-8")
    print(f"[DONE] {len(summaries)} md + INDEX.md written to {OUT_DIR}")
    print(f"[DONE] github_urls={len(github_urls)} other_urls={len(other_urls)}")


if __name__ == "__main__":
    main()
