"""主动消息推送插件的单元测试（不依赖 AstrBot 运行时）。

用标准库 unittest + 模块级 stub，验证本次修复的 4 个关键行为：
  1. is_private_umo      —— 群聊不得被自动接管（P0-1）
  2. _select_batch       —— 积压只推最新（P2-8）
  3. _send_to_target     —— 统一走 target_umo（P0-2 的底层）
  4. _remember_umo       —— 持久化与去重

运行：
  cd astrbot-plugin && python -m unittest test_main -v
"""

from __future__ import annotations

import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest


# ── 构造 AstrBot 的最小 stub，让 main.py 能被导入 ──────────────────
def _install_stubs() -> None:
    if "astrbot" in sys.modules:
        return

    # aiohttp：本机可能没装，但 main.py 只需要用到这几个符号。
    # 这里给一个能 import 的最小实现，真正发请求的路径不在单测覆盖范围。
    if "aiohttp" not in sys.modules:
        aiohttp = types.ModuleType("aiohttp")

        class _ClientError(Exception):
            pass

        class _ClientTimeout:
            def __init__(self, total=None):
                self.total = total

        class _ClientSession:
            def __init__(self, *a, **k):
                self.closed = False

            async def close(self):
                self.closed = True

            def get(self, *a, **k):  # pragma: no cover - 不发真实请求
                raise _ClientError("stub session")

            def post(self, *a, **k):  # pragma: no cover
                raise _ClientError("stub session")

        aiohttp.ClientError = _ClientError
        aiohttp.ClientTimeout = _ClientTimeout
        aiohttp.ClientSession = _ClientSession
        sys.modules["aiohttp"] = aiohttp

    astrbot = types.ModuleType("astrbot")
    api = types.ModuleType("astrbot.api")
    api.logger = types.SimpleNamespace(
        debug=lambda *a, **k: None,
        info=lambda *a, **k: None,
        warning=lambda *a, **k: None,
        error=lambda *a, **k: None,
    )

    class _AstrBotConfig(dict):
        def save_config(self):  # noqa: D401 - stub
            return None

    api.AstrBotConfig = _AstrBotConfig

    event_mod = types.ModuleType("astrbot.api.event")

    class _MessageChain:
        def __init__(self):
            self._text = ""

        def message(self, text):
            self._text = text
            return self

    event_mod.MessageChain = _MessageChain
    event_mod.AstrMessageEvent = object

    class _Filter:
        class EventMessageType:
            ALL = "ALL"

        @staticmethod
        def command(name):
            def deco(fn):
                return fn

            return deco

        @staticmethod
        def event_message_type(t):
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

    sys.modules["astrbot"] = astrbot
    sys.modules["astrbot.api"] = api
    sys.modules["astrbot.api.event"] = event_mod
    sys.modules["astrbot.api.star"] = star_mod
    astrbot.api = api
    api.event = event_mod
    api.star = star_mod


_install_stubs()

_MOD_PATH = pathlib.Path(__file__).with_name("main.py")
_spec = importlib.util.spec_from_file_location("plugin_main", _MOD_PATH)
assert _spec and _spec.loader
plugin = importlib.util.module_from_spec(_spec)
sys.modules["plugin_main"] = plugin
_spec.loader.exec_module(plugin)


# ── 测试 ──────────────────────────────────────────────────────
class TestIsPrivateUmo(unittest.TestCase):
    """P0-1：只有私聊会话才能被自动学习。"""

    def test_friend_message_is_private(self):
        self.assertTrue(plugin.is_private_umo("aiocqhttp:FriendMessage:123456789"))

    def test_private_variants(self):
        for umo in (
            "aiocqhttp:PrivateMessage:123",
            "telegram:Friend:123",
            "qq:DirectMessage:1",
        ):
            with self.subTest(umo=umo):
                self.assertTrue(plugin.is_private_umo(umo))

    def test_group_message_is_not_private(self):
        """★ 核心安全断言：群聊绝不能被自动接管。"""
        for umo in (
            "aiocqhttp:GroupMessage:987654321",
            "telegram:Group:42",
            "discord:ChannelMessage:43",
            "qq:GuildMessage:44",
        ):
            with self.subTest(umo=umo):
                self.assertFalse(plugin.is_private_umo(umo))

    def test_unknown_type_is_not_private(self):
        """无法识别时按非私聊处理（宁可不学习，也不能发错地方）。"""
        for umo in ("", "garbage", "platform:Unknown:1", ": :"):
            with self.subTest(umo=umo):
                self.assertFalse(plugin.is_private_umo(umo))

    def test_group_wins_over_friend_word(self):
        """同时含 group 与 friend 段时，群聊标记优先。"""
        self.assertFalse(plugin.is_private_umo("x:GroupMessage:FriendMessage:1"))

    def test_handles_non_string(self):
        for bad in (None, 123, [], {}):
            with self.subTest(bad=bad):
                self.assertFalse(plugin.is_private_umo(bad))  # type: ignore[arg-type]


class TestSelectBatch(unittest.TestCase):
    """P2-8：积压时只推最新一条，其余丢弃。"""

    def _make(self, n):
        return [{"id": i + 1, "content": f"msg{i + 1}"} for i in range(n)]

    def _plugin(self, push_backlog_all=False):
        cfg = {"push_backlog_all": push_backlog_all}
        return plugin.MemoryPushPlugin(context=None, config=cfg)

    def test_single_message_passes_through(self):
        p = self._plugin()
        batch, dropped = p._select_batch(self._make(1))
        self.assertEqual([m["id"] for m in batch], [1])
        self.assertEqual(dropped, [])

    def test_backlog_keeps_only_latest(self):
        """★ 积压 5 条 → 只推最后 1 条，其余 4 条归入丢弃。"""
        p = self._plugin()
        batch, dropped = p._select_batch(self._make(5))
        self.assertEqual([m["id"] for m in batch], [5])
        self.assertEqual(sorted(m["id"] for m in dropped), [1, 2, 3, 4])

    def test_empty(self):
        p = self._plugin()
        batch, dropped = p._select_batch([])
        self.assertEqual(batch, [])
        self.assertEqual(dropped, [])

    def test_push_backlog_all_keeps_everything(self):
        """显式开启 push_backlog_all 时保留旧行为（全部推送）。"""
        p = self._plugin(push_backlog_all=True)
        batch, dropped = p._select_batch(self._make(3))
        self.assertEqual(len(batch), 3)
        self.assertEqual(dropped, [])

    def test_invalid_id_is_skipped(self):
        """缺 id 的脏数据无法 ack，直接跳过而不是让整批卡住。"""
        p = self._plugin()
        msgs = [{"content": "no id"}, {"id": 2, "content": "ok"}]
        batch, _ = p._select_batch(msgs)
        self.assertEqual([m["id"] for m in batch], [2])

    def test_non_numeric_id_is_skipped(self):
        p = self._plugin()
        msgs = [{"id": "abc", "content": "bad"}, {"id": 7, "content": "ok"}]
        batch, _ = p._select_batch(msgs)
        self.assertEqual([m["id"] for m in batch], [7])


class _FakeContext:
    """记录 send_message 收到了什么。"""

    def __init__(self, result=True, raise_exc=None):
        self.calls = []
        self._result = result
        self._raise = raise_exc

    async def send_message(self, umo, chain):
        self.calls.append((umo, getattr(chain, "_text", None)))
        if self._raise:
            raise self._raise
        return self._result


class TestSendToTarget(unittest.TestCase):
    """P0-2 的底层：必须发到目标会话，而不是「回复当前消息」。"""

    def _plugin(self, ctx):
        return plugin.MemoryPushPlugin(context=ctx, config={})

    def test_sends_to_given_umo(self):
        ctx = _FakeContext()
        p = self._plugin(ctx)
        ok, err = asyncio.run(p._send_to_target("aiocqhttp:FriendMessage:1", "在吗"))
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(ctx.calls, [("aiocqhttp:FriendMessage:1", "在吗")])

    def test_false_result_reports_error(self):
        ctx = _FakeContext(result=False)
        p = self._plugin(ctx)
        ok, err = asyncio.run(p._send_to_target("u", "x"))
        self.assertFalse(ok)
        self.assertIsNotNone(err)

    def test_exception_is_swallowed(self):
        ctx = _FakeContext(raise_exc=RuntimeError("adapter boom"))
        p = self._plugin(ctx)
        ok, err = asyncio.run(p._send_to_target("u", "x"))
        self.assertFalse(ok)
        self.assertIn("adapter boom", err)

    def test_empty_umo_refuses(self):
        ctx = _FakeContext()
        p = self._plugin(ctx)
        ok, err = asyncio.run(p._send_to_target("", "x"))
        self.assertFalse(ok)
        self.assertEqual(ctx.calls, [])  # 不该调用适配器


class TestRememberUmo(unittest.TestCase):
    """UMO 持久化行为。"""

    def test_saves_new_umo(self):
        saved = {}

        class Cfg(dict):
            def save_config(self):
                saved["called"] = True

        cfg = Cfg()
        p = plugin.MemoryPushPlugin(context=None, config=cfg)
        asyncio.run(p._remember_umo("aiocqhttp:FriendMessage:9"))
        self.assertEqual(cfg["target_umo"], "aiocqhttp:FriendMessage:9")
        self.assertTrue(saved.get("called"))

    def test_skips_when_unchanged(self):
        saved = {"n": 0}

        class Cfg(dict):
            def save_config(self):
                saved["n"] += 1

        cfg = Cfg({"target_umo": "same"})
        p = plugin.MemoryPushPlugin(context=None, config=cfg)
        asyncio.run(p._remember_umo("same"))
        self.assertEqual(saved["n"], 0)  # 没变化不写盘

    def test_empty_umo_ignored(self):
        cfg = {}
        p = plugin.MemoryPushPlugin(context=None, config=cfg)
        asyncio.run(p._remember_umo(""))
        self.assertNotIn("target_umo", cfg)


class TestAutoLearnSafety(unittest.TestCase):
    """P0-1 的集成断言：auto_learn 处理器本身必须拒绝群聊。"""

    def _event(self, umo):
        return types.SimpleNamespace(unified_msg_origin=umo)

    def test_group_message_does_not_hijack(self):
        cfg = {"enable_auto_learn": True}
        p = plugin.MemoryPushPlugin(context=None, config=cfg)
        asyncio.run(p.auto_learn(self._event("aiocqhttp:GroupMessage:888")))
        self.assertNotIn("target_umo", cfg)
        self.assertEqual(p._target_umo(), "")

    def test_private_message_learns(self):
        cfg = {"enable_auto_learn": True}

        class Cfg(dict):
            def save_config(self):
                return None

        cfg = Cfg(cfg)
        p = plugin.MemoryPushPlugin(context=None, config=cfg)
        asyncio.run(p.auto_learn(self._event("aiocqhttp:FriendMessage:777")))
        self.assertEqual(p._target_umo(), "aiocqhttp:FriendMessage:777")

    def test_disabled_learn_does_nothing(self):
        cfg = {"enable_auto_learn": False}

        class Cfg(dict):
            def save_config(self):
                return None

        cfg = Cfg(cfg)
        p = plugin.MemoryPushPlugin(context=None, config=cfg)
        asyncio.run(p.auto_learn(self._event("aiocqhttp:FriendMessage:1")))
        self.assertEqual(p._target_umo(), "")


class TestQuietHours(unittest.TestCase):
    def test_empty_means_no_quiet(self):
        p = plugin.MemoryPushPlugin(context=None, config={"quiet_hours": []})
        self.assertFalse(p._in_quiet_hours())

    def test_invalid_values_are_ignored(self):
        p = plugin.MemoryPushPlugin(context=None, config={"quiet_hours": ["x", None]})
        self.assertFalse(p._in_quiet_hours())

    def test_current_hour_detected(self):
        from datetime import datetime

        hour = datetime.now(plugin.TZ_SHANGHAI).hour
        p = plugin.MemoryPushPlugin(context=None, config={"quiet_hours": [hour]})
        self.assertTrue(p._in_quiet_hours())


if __name__ == "__main__":
    unittest.main(verbosity=2)
