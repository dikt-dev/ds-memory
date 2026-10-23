"""文件读取插件的单元测试（不依赖 AstrBot 运行时与文档解析库）。

覆盖本次优化的 5 个点：
  1. TEMP_PATH_RE 不再误读消息里的无关路径
  2. 路径归一化去重，同一文件不会重复注入
  3. PDF 页数硬上限
  4. 配置非法值不崩溃（max_chars / allowed_ext）
  5. 旧版 Office 提示给出正确的另存扩展名

运行：cd astrbot-plugin-file && python -m unittest test_main -v
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import sys
import types
import unittest


# ── AstrBot 最小 stub ────────────────────────────────────────
def _install_stubs() -> None:
    if "astrbot" in sys.modules:
        return

    astrbot = types.ModuleType("astrbot")
    api = types.ModuleType("astrbot.api")
    api.logger = types.SimpleNamespace(
        debug=lambda *a, **k: None,
        info=lambda *a, **k: None,
        warning=lambda *a, **k: None,
        error=lambda *a, **k: None,
    )

    class _AstrBotConfig(dict):
        def save_config(self):
            return None

    api.AstrBotConfig = _AstrBotConfig

    event_mod = types.ModuleType("astrbot.api.event")
    event_mod.AstrMessageEvent = object

    class _Filter:
        @staticmethod
        def on_llm_request():
            def deco(fn):
                return fn

            return deco

    event_mod.filter = _Filter()

    star_mod = types.ModuleType("astrbot.api.star")

    class _Star:
        def __init__(self, context=None):
            self.context = context

    star_mod.Star = _Star
    star_mod.Context = object

    core_mod = types.ModuleType("astrbot.core")
    agent_mod = types.ModuleType("astrbot.core.agent")
    msg_mod = types.ModuleType("astrbot.core.agent.message")

    class _TextPart:
        def __init__(self, text=""):
            self.text = text

        def mark_as_temp(self):
            return self

    msg_mod.TextPart = _TextPart

    sys.modules.update(
        {
            "astrbot": astrbot,
            "astrbot.api": api,
            "astrbot.api.event": event_mod,
            "astrbot.api.star": star_mod,
            "astrbot.core": core_mod,
            "astrbot.core.agent": agent_mod,
            "astrbot.core.agent.message": msg_mod,
        }
    )
    astrbot.api = api
    astrbot.core = core_mod
    api.event = event_mod
    api.star = star_mod
    core_mod.agent = agent_mod
    agent_mod.message = msg_mod


_install_stubs()

_MOD_PATH = pathlib.Path(__file__).with_name("main.py")
_spec = importlib.util.spec_from_file_location("file_plugin_main", _MOD_PATH)
assert _spec and _spec.loader
plugin = importlib.util.module_from_spec(_spec)
sys.modules["file_plugin_main"] = plugin
_spec.loader.exec_module(plugin)


def _make_plugin(config=None):
    return plugin.FileReaderPlugin(context=None, config=config or {})


class _FakeEvent:
    """最小的事件替身，只提供 _collect_file_refs 用到的字段。"""

    def __init__(self, message_str="", components=None):
        self.message_str = message_str
        self.message_obj = types.SimpleNamespace(message=components or [])


class _FakeFileComp:
    def __init__(self, **kw):
        self.__dict__.update(kw)


# ── 优化 1：不误读无关路径 ───────────────────────────────────
class TestNoFalsePositivePath(unittest.TestCase):
    def test_bare_path_without_ext_is_ignored(self):
        p = _make_plugin()
        ev = _FakeEvent("我把项目放在 /home/user/project 里了")
        self.assertEqual(p._collect_file_refs(ev), [])

    def test_etc_path_is_ignored(self):
        p = _make_plugin()
        ev = _FakeEvent("配置在 /etc/nginx/conf.d 下面")
        self.assertEqual(p._collect_file_refs(ev), [])

    def test_path_with_known_ext_is_collected(self):
        p = _make_plugin()
        ev = _FakeEvent("看这个 /home/me/notes.md")
        refs = p._collect_file_refs(ev)
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0][1], "/home/me/notes.md")

    def test_unknown_ext_is_ignored(self):
        p = _make_plugin()
        ev = _FakeEvent("日志在 /var/log/app.weird")
        self.assertEqual(p._collect_file_refs(ev), [])

    def test_multiple_valid_paths_all_collected(self):
        p = _make_plugin()
        ev = _FakeEvent("/tmp/a.txt 和 /root/b.pdf 都看看")
        paths = {r[1] for r in p._collect_file_refs(ev)}
        self.assertEqual(paths, {"/tmp/a.txt", "/root/b.pdf"})

    def test_file_attachment_marker_still_works(self):
        """明确标记的附件允许任意扩展名（后面由白名单把关）。"""
        p = _make_plugin()
        ev = _FakeEvent("[File Attachment: name data.bin, path /root/data/temp/data.bin]")
        refs = p._collect_file_refs(ev)
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0][0], "data.bin")


# ── 优化 2：路径归一化去重 ───────────────────────────────────
class TestPathNormalization(unittest.TestCase):
    def test_duplicate_paths_deduped(self):
        """同一文件在标记与裸路径里各出现一次，只应收集一次。"""
        p = _make_plugin()
        ev = _FakeEvent(
            "[File Attachment: name a.txt, path /root/a.txt] 另外 /root/a.txt 也是它"
        )
        refs = p._collect_file_refs(ev)
        self.assertEqual(len(refs), 1)

    def test_dot_segment_normalized(self):
        p = _make_plugin()
        ev = _FakeEvent("/root/./x.txt 与 /root/x.txt")
        refs = p._collect_file_refs(ev)
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0][1], "/root/x.txt")

    def test_message_component_and_text_deduped(self):
        p = _make_plugin()
        comp = _FakeFileComp(file="/tmp/s.doc", name="s.doc")
        ev = _FakeEvent("[File Attachment: name s.doc, path /tmp/s.doc]", [comp])
        refs = p._collect_file_refs(ev)
        self.assertEqual(len(refs), 1)

    def test_relative_path_rejected(self):
        p = _make_plugin()
        comp = _FakeFileComp(file="relative/a.txt")
        ev = _FakeEvent("", [comp])
        self.assertEqual(p._collect_file_refs(ev), [])


# ── 优化 4：配置防御 ────────────────────────────────────────
class TestConfigDefense(unittest.TestCase):
    def test_max_chars_invalid_string_falls_back(self):
        p = _make_plugin({"max_chars": "abc"})
        self.assertEqual(p._max_chars(), 16000)

    def test_max_chars_none_falls_back(self):
        p = _make_plugin({"max_chars": None})
        self.assertEqual(p._max_chars(), 16000)

    def test_max_chars_clamped_low(self):
        p = _make_plugin({"max_chars": 10})
        self.assertEqual(p._max_chars(), plugin.MAX_CHARS_FLOOR)

    def test_max_chars_clamped_high(self):
        p = _make_plugin({"max_chars": 10**9})
        self.assertEqual(p._max_chars(), plugin.MAX_CHARS_CEIL)

    def test_max_chars_valid(self):
        p = _make_plugin({"max_chars": 5000})
        self.assertEqual(p._max_chars(), 5000)

    def test_allowed_ext_normalizes_dot(self):
        p = _make_plugin({"allowed_ext": "txt, .MD ,,PDF"})
        self.assertEqual(p._allowed_exts(), {".txt", ".md", ".pdf"})

    def test_allowed_ext_empty(self):
        p = _make_plugin({"allowed_ext": ""})
        self.assertEqual(p._allowed_exts(), set())

    def test_allowed_ext_whitespace_only(self):
        p = _make_plugin({"allowed_ext": "   ,  "})
        self.assertEqual(p._allowed_exts(), set())


# ── 优化 5：旧版 Office 提示 ────────────────────────────────
class TestLegacyOfficeSuggestion(unittest.TestCase):
    def test_mapping_is_explicit(self):
        self.assertEqual(plugin.LEGACY_DOC_SUGGEST[".doc"], ".docx")
        self.assertEqual(plugin.LEGACY_DOC_SUGGEST[".xls"], ".xlsx")
        self.assertEqual(plugin.LEGACY_DOC_SUGGEST[".ppt"], ".pptx")

    def test_legacy_set_derived_from_mapping(self):
        self.assertEqual(plugin.LEGACY_DOC_EXTS, set(plugin.LEGACY_DOC_SUGGEST))

    def test_no_fragile_ext_x_concat(self):
        """确认不再用 f"{ext}x" 这种依赖巧合的写法（注释里提到不算）。"""
        src = _MOD_PATH.read_text(encoding="utf-8")
        code_lines = [
            ln for ln in src.splitlines()
            if not ln.lstrip().startswith("#")
        ]
        code = "\n".join(code_lines)
        self.assertNotIn('{ext}x', code)
        # 确认改用显式映射
        self.assertIn("LEGACY_DOC_SUGGEST", code)


# ── 优化 3：PDF 页数上限常量 ────────────────────────────────
class TestPdfLimits(unittest.TestCase):
    def test_page_cap_exists(self):
        self.assertGreater(plugin.MAX_PDF_PAGES, 0)
        self.assertLessEqual(plugin.MAX_PDF_PAGES, 1000)

    def test_char_cap_exists(self):
        self.assertGreater(plugin.PDF_MAX_CHARS, 0)

    def test_pdf_missing_lib_returns_friendly_error(self):
        """本机没装 pypdf 时，应返回可读提示而不是抛异常。"""
        p = _make_plugin()
        text, err = p._read_pdf("/tmp/nonexistent.pdf")
        # 两种结果都可接受：缺库提示，或文件不存在
        self.assertEqual(text, "")
        self.assertIsNotNone(err)

    def test_read_any_rejects_missing_file(self):
        p = _make_plugin()
        text, err = p._read_any("/nonexistent/x.txt", ".txt", 1000)
        self.assertEqual(text, "")
        self.assertIn("不存在", err)

    def test_read_any_rejects_directory(self):
        p = _make_plugin()
        text, err = p._read_any(str(_MOD_PATH.parent), ".txt", 1000)
        self.assertEqual(text, "")
        self.assertIsNotNone(err)


class TestNormalizePosixPath(unittest.TestCase):
    """★ 跨平台：归一化不得把正斜杠变成反斜杠。"""

    def test_keeps_forward_slash(self):
        self.assertEqual(plugin._normalize_posix_path("/root/a.txt"), "/root/a.txt")

    def test_collapses_double_slash(self):
        self.assertEqual(plugin._normalize_posix_path("/root//a.txt"), "/root/a.txt")

    def test_removes_dot_segment(self):
        self.assertEqual(plugin._normalize_posix_path("/root/./a.txt"), "/root/a.txt")

    def test_no_backslash_on_any_platform(self):
        out = plugin._normalize_posix_path("/root/./sub//a.txt")
        self.assertNotIn("\\", out)
        self.assertEqual(out, "/root/sub/a.txt")

    def test_relative_rejected(self):
        self.assertEqual(plugin._normalize_posix_path("a/b.txt"), "")

    def test_empty(self):
        self.assertEqual(plugin._normalize_posix_path(""), "")
        self.assertEqual(plugin._normalize_posix_path("/"), "")


class TestTruncate(unittest.TestCase):
    def test_short_text_untouched(self):
        p = _make_plugin()
        text, err = p._truncate("abc", 100)
        self.assertEqual(text, "abc")
        self.assertIsNone(err)

    def test_long_text_truncated_with_note(self):
        p = _make_plugin()
        text, _ = p._truncate("x" * 500, 100)
        self.assertIn("已截断", text)
        self.assertLess(len(text), 500)


if __name__ == "__main__":
    unittest.main(verbosity=2)
