"""文件读取给小忆。

解决的问题：
AstrBot 把用户发来的文件只以「文件名 + 本地路径」的形式传给上游 LLM
（例如 `[File Attachment: name a.txt, path /root/data/temp/xxx.txt]`），
而小忆跑在 Cloudflare Workers 上，**拿不到 AstrBot 所在机器的本地文件**，
所以模型只能看到路径，读不到内容。

本插件在 AstrBot 侧拦截 LLM 请求，把文件真正读出来，作为额外的用户内容
注入到请求里，模型于是能「看到」文件内容。

作者：dikt-dev
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star

try:  # TextPart 在较新版本才作为独立模块导出
    from astrbot.core.agent.message import TextPart
except Exception:  # pragma: no cover - 兼容旧版本
    TextPart = None  # type: ignore[assignment]

# 从消息文本里匹配 AstrBot 生成的文件路径标记
FILE_MARKER_RE = re.compile(
    r"\[File Attachment:\s*name\s+(?P<name>[^,\]]+?)\s*,\s*path\s+(?P<path>[^\]]+?)\]",
    re.IGNORECASE,
)

# 兜底用的路径白名单前缀（只允许这些目录下的文件）
SAFE_PATH_PREFIXES = ("root", "tmp", "home", "data", "var")

# 兜底：裸的本地临时文件路径。
#
# ★ 防误读：仅靠「长得像路径」不够——用户在聊天里说一句
#   “我把配置放在 /home/me/project 里了”，也会被当成文件去读，
#   结果注入一条「读取失败：文件不存在」，干扰对话。
#   因此要求路径末尾带一个已知的文件扩展名，才当作候选。
_KNOWN_EXTS = (
    # 文本类
    "txt", "md", "markdown", "json", "yaml", "yml", "xml", "csv", "tsv",
    "log", "ini", "toml", "conf", "cfg", "env", "sql", "py", "js", "ts",
    "jsx", "tsx", "html", "htm", "css", "scss", "sh", "bash", "zsh",
    "java", "c", "h", "cpp", "hpp", "go", "rs", "rb", "php", "swift",
    "kt", "lua", "r", "m", "tex",
    # 文档类
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
)
_EXT_ALT = "|".join(_KNOWN_EXTS)
TEMP_PATH_RE = re.compile(
    rf"(/(?:{'|'.join(SAFE_PATH_PREFIXES)})/[^\s\]\)]*\.(?:{_EXT_ALT}))(?![\w])",
    re.IGNORECASE,
)

MAX_FILE_BYTES = 2 * 1024 * 1024  # 单文件读取上限（防超大文件拖垮）

# 二进制文档扩展名 → 解析器（需要 requirements.txt 里的第三方库）
DOC_EXTS = {".pdf", ".docx", ".xlsx", ".pptx"}
# 旧版 Office 格式 → 建议另存的格式（不要用 f"{ext}x" 这种“巧合”写法）
LEGACY_DOC_SUGGEST = {
    ".doc": ".docx",
    ".xls": ".xlsx",
    ".ppt": ".pptx",
}
LEGACY_DOC_EXTS = set(LEGACY_DOC_SUGGEST)

# PDF 硬性上限（字符数之外再加页数，防图片型 PDF 遍历三千页）
MAX_PDF_PAGES = 300
PDF_MAX_CHARS = 60000

"""单次注入的字符预算下限 / 上限（防御配置写错）。"""
MAX_CHARS_FLOOR = 1000
MAX_CHARS_CEIL = 200000


def _normalize_posix_path(path: str) -> str:
    """纯字符串归一化 POSIX 路径（不依赖平台，不碰文件系统）。

    - 折叠重复斜杠：`/root//a.txt` → `/root/a.txt`
    - 去除 `.` 段：`/root/./a.txt` → `/root/a.txt`
    - 保留 `..` 原样（真去解析可能跳出允许目录，交给后续路径校验）

    ★ 不用 os.path.normpath：它在 Windows 上输出反斜杠，
      而 AstrBot 跑在 Linux，路径必须保持正斜杠。
    """
    if not path or not path.startswith("/"):
        return ""
    parts = [seg for seg in path.split("/") if seg not in ("", ".")]
    if not parts:
        return ""
    return "/" + "/".join(parts)


class FileReaderPlugin(Star):
    """把用户发来的文本文件内容注入 LLM 请求。"""

    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config

    def _allowed_exts(self) -> set[str]:
        """读取允许的扩展名。空集 = 不限制（走默认白名单）。"""
        raw = str(self.config.get("allowed_ext") or "")
        exts: set[str] = set()
        for e in raw.split(","):
            e = e.strip().lower()
            if not e:
                continue
            # 容错：用户可能写成 "txt" 或 ".txt"
            if not e.startswith("."):
                e = "." + e
            exts.add(e)
        return exts

    def _max_chars(self) -> int:
        """读取并**限制**字符预算：配置写错时不抛异常。"""
        try:
            n = int(self.config.get("max_chars", 16000))
        except (TypeError, ValueError):
            logger.warning("[文件读取] max_chars 配置非法，回退默认 16000")
            return 16000
        if n < MAX_CHARS_FLOOR:
            return MAX_CHARS_FLOOR
        if n > MAX_CHARS_CEIL:
            return MAX_CHARS_CEIL
        return n

    @filter.on_llm_request()
    async def inject_file_content(self, event: AstrMessageEvent, req) -> None:
        """在 LLM 请求前，把本次消息里的文件内容读出来注入。"""
        if not self.config.get("enable", True):
            return

        try:
            candidates = self._collect_file_refs(event)
            if not candidates:
                return

            max_chars = self._max_chars()
            allowed = self._allowed_exts()
            blocks: list[str] = []

            for name, path in candidates:
                ext = Path(name or path).suffix.lower()
                if ext in LEGACY_DOC_EXTS:
                    suggest = LEGACY_DOC_SUGGEST[ext]
                    blocks.append(
                        f"【文件：{name}】\n（旧版 Office 格式 {ext} 暂不支持，"
                        f"请在 Office/WPS 里另存为 {suggest} 后再发）"
                    )
                    continue
                if allowed and ext not in allowed and ext not in DOC_EXTS:
                    blocks.append(
                        f"【文件：{name}】\n（该类型（{ext or '未知'}）暂不支持读取，"
                        f"只支持文本类文件和 PDF/Word/Excel/PPT）"
                    )
                    continue

                text, err = self._read_any(path, ext, max_chars)
                if err:
                    blocks.append(f"【文件：{name}】\n（读取失败：{err}）")
                    continue
                blocks.append(f"【文件：{name}】\n```\n{text}\n```")

            if not blocks:
                return

            merged = (
                "<file_content>\n"
                + "\n\n".join(blocks)
                + "\n</file_content>\n"
                + "（以上是用户本轮发来的文件内容，请据此回答；用户如果没提具体要求，可以简要说说你看到了什么。）"
            )

            if TextPart is None:
                logger.warning("[文件读取] 当前 AstrBot 版本不支持 TextPart，无法注入")
                return

            part = TextPart(text=merged)
            # 标记为临时内容：只参与本轮请求，不写入会话历史（避免重复膨胀）
            # 不同版本可能返回 self 或 None，做容错处理
            mark = getattr(part, "mark_as_temp", None)
            if callable(mark):
                marked = mark()
                if marked is not None:
                    part = marked

            req.extra_user_content_parts.append(part)
            logger.info(f"[文件读取] 已注入 {len(blocks)} 个文件内容（约 {len(merged)} 字）")
        except Exception as e:  # 不因插件异常影响正常聊天
            logger.error(f"[文件读取] 注入失败：{e}")

    # ── 内部工具 ──────────────────────────────────────────

    def _collect_file_refs(self, event: AstrMessageEvent) -> list[tuple[str, str]]:
        """从消息链与消息文本中收集（文件名, 本地路径）。

        优先读消息链里的 File 组件真实路径；拿不到就退回正则匹配文本标记。

        ★ 路径归一化：同一文件可能在三个来源里以不同写法出现
          （`/root/a.txt` / `/root/./a.txt` / `root/a.txt`），
          不归一化会重复读、重复注入。这里用 os.path.normpath 去重。
        """
        found: dict[str, str] = {}  # normalized_path -> name

        def add(path: str, name: str) -> None:
            """归一化后收录；保留第一个出现的名字。

            ★ 不用 os.path.normpath：它在 Windows 上会把 `/root/a.txt` 转成
              `\\root\\a.txt`，而 AstrBot 跑在 Linux，路径必须保持正斜杠。
              这里只做纯字符串层面的归一化（折叠 `.` / 重复斜杠）。
            """
            p = (path or "").strip()
            if not p or not p.startswith("/"):
                return
            norm = _normalize_posix_path(p)
            if not norm or norm in found:
                return
            found[norm] = name or norm.rsplit("/", 1)[-1]

        # ① 消息链组件（不同适配器字段名不同，做宽松探测）
        try:
            for comp in getattr(event.message_obj, "message", []) or []:
                cls_name = type(comp).__name__.lower()
                if "file" not in cls_name and "attachment" not in cls_name:
                    continue
                path = ""
                name = ""
                for attr in ("file", "path", "file_path", "url", "name", "file_name"):
                    val = getattr(comp, attr, None)
                    if isinstance(val, str) and val:
                        if attr in ("name", "file_name"):
                            name = val
                        elif not path:
                            path = val
                add(path, name)
        except Exception:
            pass

        text = getattr(event, "message_str", "") or ""

        # ② 正则匹配 AstrBot 的 File Attachment 标记
        #    这是**明确标记**，不要求扩展名（附件可能是任意类型，
        #    后面由 allowed_ext / DOC_EXTS 把关）
        for m in FILE_MARKER_RE.finditer(text):
            add((m.group("path") or "").strip(), (m.group("name") or "").strip())

        # ③ 兜底：裸的临时文件路径（已限定必须是已知扩展名结尾）
        for m in TEMP_PATH_RE.finditer(text):
            p = m.group(1).strip().rstrip(".,;:!?")
            add(p, os.path.basename(p))

        return [(name, path) for path, name in found.items()]

    def _read_text(self, path: str, max_chars: int) -> tuple[str, str | None]:
        """读取文本文件，返回 (内容, 错误信息)。"""
        try:
            p = Path(path)
            if not p.exists():
                return "", "文件不存在或已被清理"
            if not p.is_file():
                return "", "不是普通文件"
            size = p.stat().st_size
            if size > MAX_FILE_BYTES:
                return "", f"文件过大（{size // 1024}KB）"

            raw = p.read_bytes()
            for enc in ("utf-8", "utf-8-sig", "gb18030", "utf-16"):
                try:
                    text = raw.decode(enc)
                    break
                except UnicodeDecodeError:
                    continue
            else:
                return "", "无法识别编码（可能是二进制文件）"

            if "\x00" in text[:1000]:
                return "", "看起来是二进制文件"

            return self._truncate(text, max_chars)
        except Exception as e:
            return "", str(e)

    # ── 文档解析（PDF / Word / Excel / PPT） ─────────────────

    def _read_any(self, path: str, ext: str, max_chars: int) -> tuple[str, str | None]:
        """按扩展名分派到对应解析器。"""
        p = Path(path)
        if not p.exists():
            return "", "文件不存在或已被清理"
        if not p.is_file():
            return "", "不是普通文件"
        size = p.stat().st_size
        if size > MAX_FILE_BYTES:
            return "", f"文件过大（{size // 1024}KB）"

        parser = {
            ".pdf": self._read_pdf,
            ".docx": self._read_docx,
            ".xlsx": self._read_xlsx,
            ".pptx": self._read_pptx,
        }.get(ext)
        if parser is None:
            return self._read_text(path, max_chars)
        try:
            text, err = parser(str(p))
            if err:
                return "", err
            return self._truncate(text, max_chars)
        except Exception as e:
            return "", f"{type(e).__name__}: {e}"

    def _truncate(self, text: str, max_chars: int) -> tuple[str, str | None]:
        if len(text) > max_chars:
            return text[:max_chars] + f"\n…（已截断，原内容共 {len(text)} 字）", None
        return text, None

    def _read_pdf(self, path: str) -> tuple[str, str | None]:
        try:
            from pypdf import PdfReader  # type: ignore
        except ImportError:
            return "", "缺少 pypdf 库，请在 AstrBot 环境执行 pip install pypdf"

        reader = PdfReader(path)
        total_pages = len(reader.pages)

        # ★ 页数硬上限：图片型 PDF 每页都提取不到文字，
        #   若只按字符数判断，会遍历完所有页（三千页会卡很久）。
        page_limit = min(total_pages, MAX_PDF_PAGES)

        parts: list[str] = []
        extracted_chars = 0
        for i in range(page_limit):
            page = reader.pages[i]
            try:
                t = page.extract_text() or ""
            except Exception:
                t = ""
            if t.strip():
                parts.append(f"## 第 {i + 1} 页\n{t.strip()}")
                extracted_chars += len(t)
            if extracted_chars > PDF_MAX_CHARS:  # 超大 PDF 保护
                parts.append("…（页数太多，已截断）")
                break

        if total_pages > page_limit and not parts:
            return "", f"PDF 共 {total_pages} 页，只扫描了前 {page_limit} 页且未找到文字"
        if not parts:
            return "", "PDF 里没有可提取的文字（可能是扫描件/图片型 PDF）"
        if total_pages > page_limit:
            parts.append(f"…（共 {total_pages} 页，只提取了前 {page_limit} 页）")
        return "\n\n".join(parts), None

    def _read_docx(self, path: str) -> tuple[str, str | None]:
        try:
            import docx  # type: ignore
        except ImportError:
            return "", "缺少 python-docx 库，请执行 pip install python-docx"

        d = docx.Document(path)
        parts: list[str] = []
        for para in d.paragraphs:
            t = (para.text or "").strip()
            if t:
                # 保留标题层级
                style = getattr(para, "style", None)
                name = getattr(style, "name", "") if style is not None else ""
                if name and name.lower().startswith("heading"):
                    parts.append(f"## {t}")
                else:
                    parts.append(t)
        # 表格
        for ti, table in enumerate(d.tables, 1):
            rows: list[str] = []
            for row in table.rows:
                cells = [(c.text or "").strip().replace("\n", " ") for c in row.cells]
                if any(cells):
                    rows.append(" | ".join(cells))
            if rows:
                parts.append(f"## 表格 {ti}\n" + "\n".join(rows))
        if not parts:
            return "", "Word 文档里没有文字内容"
        return "\n\n".join(parts), None

    def _read_xlsx(self, path: str) -> tuple[str, str | None]:
        try:
            import openpyxl  # type: ignore
        except ImportError:
            return "", "缺少 openpyxl 库，请执行 pip install openpyxl"

        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        parts: list[str] = []
        try:
            for ws in wb.worksheets:
                rows: list[str] = []
                count = 0
                for row in ws.iter_rows(values_only=True):
                    if row is None:
                        continue
                    cells = ["" if v is None else str(v) for v in row]
                    if not any(c.strip() for c in cells):
                        continue
                    rows.append(" | ".join(cells))
                    count += 1
                    if count >= 500:  # 单表最多 500 行，避免刷屏
                        rows.append("…（行数过多，已截断）")
                        break
                if rows:
                    parts.append(f"## 工作表：{ws.title}\n" + "\n".join(rows))
        finally:
            try:
                wb.close()
            except Exception:
                pass
        if not parts:
            return "", "Excel 表格里没有数据"
        return "\n\n".join(parts), None

    def _read_pptx(self, path: str) -> tuple[str, str | None]:
        try:
            from pptx import Presentation  # type: ignore
        except ImportError:
            return "", "缺少 python-pptx 库，请执行 pip install python-pptx"

        prs = Presentation(path)
        parts: list[str] = []
        for i, slide in enumerate(prs.slides, 1):
            texts: list[str] = []
            for shape in slide.shapes:
                if getattr(shape, "has_text_frame", False):
                    t = (shape.text_frame.text or "").strip()
                    if t:
                        texts.append(t)
            if texts:
                parts.append(f"## 第 {i} 页\n" + "\n".join(texts))
        if not parts:
            return "", "PPT 里没有文字内容"
        return "\n\n".join(parts), None

    async def terminate(self):
        """无后台任务，无需清理。"""
