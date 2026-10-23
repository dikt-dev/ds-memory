"""小忆主动消息推送插件。

原理：Cloudflare Worker 在合适的时机把「小忆主动想说的话」写入 D1 的
proactive_queue 表；本插件定时轮询 /api/proactive/pending 拉取，用
AstrBot 的 context.send_message(umo, chain) 推到 QQ，然后 ack 确认。

之所以用「反向轮询」而不是 Worker 直接推送：
Cloudflare Workers 无法维持 WebSocket 长连接，也无法直接访问局域网内的
AstrBot，因此由 AstrBot 主动往外拉是最稳的方式。

作者：dikt-dev
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

import aiohttp

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star

# 北京时间
TZ_SHANGHAI = timezone(timedelta(hours=8))


class MemoryPushPlugin(Star):
    """主动消息推送插件。

    注意：不要在类上使用 @register 装饰器——AstrBot 4.x 通过 metadata.yaml
    识别插件元数据，两者同时使用会导致冲突。
    """

    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self._task: asyncio.Task | None = None
        self._http: aiohttp.ClientSession | None = None
        # 最近一次推送时间，用于限流
        self._last_push_at: float = 0.0
        # 是否已经提示过配置缺失（避免刷日志）
        self._warned_missing_config = False
        # 连续发送失败次数（用于自动清理失效会话）
        self._fail_streak = 0

    # ── 生命周期 ──────────────────────────────────────────

    async def initialize(self):
        """插件启用时启动轮询任务（AstrBot 会在插件加载后调用）。"""
        base = (self.config.get("ds_base_url") or "").strip().rstrip("/")
        key = (self.config.get("api_key") or "").strip()
        if not base or not key:
            if not self._warned_missing_config:
                logger.warning(
                    "[小忆] 未配置 ds_base_url 或 api_key，主动推送不会启动。"
                    "请在插件配置里填写后再重载插件。"
                )
                self._warned_missing_config = True
            return

        if self._task and not self._task.done():
            logger.info("[小忆] 轮询任务已在运行，跳过重复启动")
            return

        self._task = asyncio.create_task(self._poll_loop())
        logger.info(
            f"[小忆] 主动消息推送已启动（{base}，每 "
            f"{self.config.get('poll_interval', 60)} 秒轮询一次）"
        )

    async def terminate(self):
        """插件停用/卸载时清理。"""
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            logger.info("[小忆] 轮询任务已停止")
        if self._http and not self._http.closed:
            await self._http.close()

    # ── 轮询主循环 ────────────────────────────────────────

    async def _poll_loop(self):
        """持续轮询，遇到异常不退出，只记录日志。"""
        while True:
            try:
                await self._poll_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"[小忆] 轮询出错：{e}")

            interval = max(30, int(self.config.get("poll_interval", 60)))
            await asyncio.sleep(interval)

    async def _poll_once(self):
        """拉取并推送一批待发消息。"""
        ump = self._target_umo()
        if not ump:
            # 还没学到会话，先跳过（等用户发一条消息）
            return

        if self._in_quiet_hours():
            logger.debug("[小忆] 当前处于免打扰时段，跳过推送")
            return

        messages = await self._fetch_pending()
        if not messages:
            return

        acked: list[int] = []
        for msg in messages:
            content = (msg.get("content") or "").strip()
            if not content:
                # 空内容直接 ack，避免卡在队列里重试
                acked.append(int(msg["id"]))
                continue

            try:
                chain = MessageChain().message(content)
                ok = await self.context.send_message(ump, chain)
                if ok:
                    acked.append(int(msg["id"]))
                    self._fail_streak = 0
                    logger.info(f"[小忆] 已推送 #{msg['id']}：{content[:40]}...")
                else:
                    logger.warning(
                        f"[小忆] 推送 #{msg['id']} 失败：目标会话 {ump} 不可用"
                        "（换过适配器/机器人后旧会话会失效）"
                    )
                    await self._nack([int(msg["id"])])
                    await self._handle_send_failure()
                    break
            except Exception as e:
                logger.error(f"[小忆] 推送 #{msg['id']} 异常：{e}")
                await self._nack([int(msg["id"])])
                await self._handle_send_failure()
                break

            # 多条之间稍作停顿，避免被平台判定为刷屏
            await asyncio.sleep(1.5)

        if acked:
            await self._ack(acked)
            self._last_push_at = time.time()

    # ── 与 Worker 通信 ────────────────────────────────────

    def _http_session(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            timeout = aiohttp.ClientTimeout(total=20)
            self._http = aiohttp.ClientSession(timeout=timeout)
        return self._http

    def _base_url(self) -> str:
        return (self.config.get("ds_base_url") or "").strip().rstrip("/")

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {(self.config.get('api_key') or '').strip()}",
            "Content-Type": "application/json",
        }

    async def _fetch_pending(self) -> list[dict]:
        """GET /api/proactive/pending"""
        limit = max(1, min(int(self.config.get("max_per_poll", 5)), 20))
        url = f"{self._base_url()}/api/proactive/pending?limit={limit}"
        try:
            async with self._http_session().get(url, headers=self._headers()) as resp:
                if resp.status == 401:
                    logger.error("[小忆] api_key 不对，拉取被拒绝（401）")
                    return []
                if resp.status != 200:
                    text = await resp.text()
                    logger.warning(f"[小忆] 拉取失败 HTTP {resp.status}：{text[:200]}")
                    return []
                data = await resp.json()
                return data.get("messages") or []
        except aiohttp.ClientError as e:
            logger.warning(f"[小忆] 网络错误：{e}")
            return []

    async def _ack(self, ids: list[int]) -> None:
        """POST /api/proactive/ack"""
        url = f"{self._base_url()}/api/proactive/ack"
        try:
            async with self._http_session().post(
                url, headers=self._headers(), json={"ids": ids}
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    logger.warning(f"[小忆] ack 失败 HTTP {resp.status}：{text[:200]}")
        except aiohttp.ClientError as e:
            logger.warning(f"[小忆] ack 网络错误：{e}")

    async def _nack(self, ids: list[int]) -> None:
        """POST /api/proactive/nack：告诉 Worker 这次发送失败了。

        Worker 侧拉取不再计尝试次数（拉取≠送达），必须由插件主动上报失败，
        否则「发送失败」会让消息在几次轮询后被静默丢弃。
        """
        if not ids:
            return
        url = f"{self._base_url()}/api/proactive/nack"
        try:
            async with self._http_session().post(
                url, headers=self._headers(), json={"ids": ids}
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    logger.warning(f"[小忆] nack 失败 HTTP {resp.status}：{text[:120]}")
        except aiohttp.ClientError as e:
            logger.warning(f"[小忆] nack 网络错误：{e}")

    async def _handle_send_failure(self) -> None:
        """连续失败两次就清掉失效的目标会话，等用户再发消息时重新学习。

        典型场景：从 NapCat 换到 QQ 官方接口后，旧 UMO 里的平台标识失效，
        send_message 永远返回 False。
        """
        self._fail_streak += 1
        if self._fail_streak < 2:
            return
        if not self.config.get("enable_auto_learn", True):
            return
        if not self._target_umo():
            return
        self.config["target_umo"] = ""
        try:
            self.config.save_config()
        except Exception as e:
            logger.warning(f"[小忆] 清除失效会话失败：{e}")
            return
        logger.warning(
            "[小忆] 连续发送失败，已清除失效的目标会话；"
            "请在要接收主动消息的聊天窗口发一句话，插件会自动重新学习"
        )
        self._fail_streak = 0

    # ── UMO 管理 ─────────────────────────────────────────

    def _target_umo(self) -> str:
        return (self.config.get("target_umo") or "").strip()

    async def _remember_umo(self, umo: str) -> None:
        """记住会话 UMO，并持久化到插件配置。"""
        if not umo or umo == self._target_umo():
            return
        self.config["target_umo"] = umo
        try:
            self.config.save_config()
            logger.info(f"[小忆] 已记录目标会话：{umo}")
        except Exception as e:
            logger.warning(f"[小忆] 保存 UMO 失败：{e}")

    # ── 免打扰 ───────────────────────────────────────────

    def _in_quiet_hours(self) -> bool:
        hours = self.config.get("quiet_hours") or []
        if not hours:
            return False
        now_hour = datetime.now(TZ_SHANGHAI).hour
        try:
            quiet = {int(h) for h in hours}
        except (TypeError, ValueError):
            return False
        return now_hour in quiet

    # ── 指令 ─────────────────────────────────────────────

    @filter.command("肥鱼状态")
    async def status(self, event: AstrMessageEvent):
        """查看主动推送状态。"""
        umo = self._target_umo()
        lines = [
            "🐟 小忆主动推送状态",
            f"服务：{self._base_url() or '（未配置）'}",
            f"目标会话：{umo or '（未学习，先在这里说句话）'}",
            f"轮询间隔：{self.config.get('poll_interval', 60)} 秒",
            f"免打扰：{self.config.get('quiet_hours') or '无'} 时",
        ]
        if umo:
            pending = await self._fetch_pending()
            lines.append(f"当前待发：{len(pending)} 条")
        yield event.plain_result("\n".join(lines))

    @filter.command("肥鱼立即推送")
    async def push_now(self, event: AstrMessageEvent):
        """立即拉取并推送一次（调试用）。"""
        if not self._target_umo():
            yield event.plain_result("还没学习到会话 UMO，请先直接发一条消息给我。")
            return
        messages = await self._fetch_pending()
        if not messages:
            yield event.plain_result("当前队列是空的，小忆暂时没想说的话。")
            return

        pulled_ids = [int(m["id"]) for m in messages]
        count = 0
        sent_ids: list[int] = []
        for msg in messages:
            content = (msg.get("content") or "").strip()
            if not content:
                sent_ids.append(int(msg["id"]))
                continue
            try:
                yield event.plain_result(content)
                sent_ids.append(int(msg["id"]))
                count += 1
                await asyncio.sleep(1.5)
            except Exception as e:
                logger.error(f"[小忆] 手动推送失败：{e}")
                break

        if sent_ids:
            await self._ack(sent_ids)
        logger.info(f"[小忆] 手动推送了 {count} 条（拉取 {len(pulled_ids)} 条）")

    @filter.command("肥鱼记住这里")
    async def remember_here(self, event: AstrMessageEvent):
        """把当前会话设为目标推送会话。"""
        umo = event.unified_msg_origin
        await self._remember_umo(umo)
        yield event.plain_result(f"好的，以后主动消息就发到这里啦～\n（{umo}）")

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def auto_learn(self, event: AstrMessageEvent):
        """自动学习：收到消息就把该会话记为目标。

        ★ 不再「已配置就跳过」——换了适配器（NapCat→QQ 官方）、换了群/好友后，
        旧 UMO 会永久失效，必须让最近说话的会话自动接管。
        """
        if not self.config.get("enable_auto_learn", True):
            return
        await self._remember_umo(event.unified_msg_origin)
