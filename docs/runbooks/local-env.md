# 鏈湴鍙鐜扮幆澧?
> 2026-10-31 寤虹珛銆傝В鍐崇殑鏄繖涓」鐩渶璐电殑涓€涓棶棰橈細**鏀逛簡鐪嬩笉瑙?*銆?
## 1. 涓轰粈涔堥渶瑕佸畠

`wrangler tail` 鍦ㄥ紑鍙戣€呯殑缃戠粶涓婅繛涓嶄笂锛堝埌 `173.231.12.107:443` 瓒呮椂锛夛紝绾夸笂鏃ュ織绛変簬娌℃湁銆?浜庢槸杩囧幓涓夋缈昏溅閮芥槸鍚屼竴涓ā寮忥細鏀逛唬鐮?鈫?閮ㄧ讲 鈫?鐢ㄦ埛璇淬€屾病鍙樺寲銆嶁啋 鍒嗕笉娓呮槸浠ｇ爜銆佺紦瀛樿繕鏄儴缃叉病鐢熸晥銆?
鏈変簡鏈湴鐜锛屾敼鍔ㄥ彲浠ュ湪銆岀湡瀹炴暟鎹?+ 鐪熷疄 SQL銆嶄笂鍏堣窇鍑虹粨璁猴紝鍐嶅喅瀹氫笂涓嶄笂绾裤€?閰嶅鐨?`request_log`锛堣 `src/request-log.ts`锛夎绾夸笂涔熸湁鍙瘮瀵圭殑鑰楁椂鏁版嵁銆?
## 2. 鐢ㄦ硶

```powershell
cd D:\WorkSpace\ds\ds-memory

# 瀵煎嚭绾夸笂 D1 鈫?娓呯┖鏈湴 鈫?瀵煎叆 鈫?璧?worker锛堥粯璁?8799 绔彛锛?.\scripts\local-env.ps1

# 澶嶇敤涓婃鐨勫揩鐓э紝鐩存帴璧凤紙鐪?20~60 绉掞級
.\scripts\local-env.ps1 -SkipExport
```

璧锋潵涔嬪悗锛?
```powershell
curl http://127.0.0.1:8799/api/health
curl http://127.0.0.1:8799/api/day
```

## 3. 瑕嗙洊鑼冨洿涓庡凡鐭ョ┖鐧?
| 璧勬簮 | 鏈湴鐘舵€?| 璇存槑 |
|---|---|---|
| D1 | 涓庣嚎涓婁竴鑷?| messages / memory_facts / memory_events / memory_chunks / runtime_state / engine_metrics / cron_runs 鈥?鍏ㄩ儴瀵煎叆 |
| KV | 绌?| 璁板繂缂撳瓨銆佹憳瑕併€侀攣閮藉湪杩欓噷锛涚┖ KV 浼氳浠ｇ爜璧般€屽洖婧?閲嶅缓銆嶈矾寰勶紝鎭板ソ鑳芥祴闄嶇骇 |
| R2 | 绌?| **`memory.md` 鍦?R2 閲岋紝鎵€浠ユ湰鍦伴暱鏈熻蹇嗕负绌?*鈥斺€旈渶瑕佸畬鏁村鐜版椂鎵嬪姩鏀句竴浠?|
| Workers AI | 鏈湴鏄々 | 鍚戦噺鍙洖鍦ㄦ湰鍦伴€€鍖栨垚绾叧閿瘝锛屾濂芥槸鎴戜滑瑕佹祴鐨勯檷绾ц矾寰?|
| DeepSeek | 鐪?key | `.dev.vars` 閲岀殑 key 浼氱湡鐨勮璋冪敤锛?*鑱婂ぉ浼氳璐?* |

瑕佹妸 `memory.md` 涔熸惉涓嬫潵锛屼簩閫変竴锛?
```powershell
# A. 鐢ㄤ粨搴撻噷宸叉湁鐨勮蹇嗗揩鐓?Copy-Item .\backup\r2\memory.md .\tmp\memory.md

# B. 浠庣嚎涓婃帴鍙ｇ‘璁ゅ綋鍓嶅ぇ灏忥紙闇€瑕佺櫥褰?cookie锛?curl -H "Cookie: ds_token=..." https://fae.us.ci/api/admin/stats
```

鏈湴 R2 钀界洏浣嶇疆鍦?`.wrangler\state\v3\r2\`锛屾妸鏂囦欢鏀捐繘鍘诲嵆鍙 `getObject` 璇诲埌銆?
## 4. 鐧诲綍鏈湴瀹炰緥

鏈湴鍚屾牱鐢ㄧ鍚?cookie銆備袱绉嶅姙娉曪細

1. **璧版甯哥櫥褰?*锛氭祻瑙堝櫒寮€ `http://127.0.0.1:8799`锛岀敤骞虫椂鐨勫彛浠わ紙`ACCESS_PASSWORD_HASH` 鍦?`.dev.vars` 閲岋級銆?2. **鐩存帴绛句竴涓?token**锛堣剼鏈皟璇曠敤锛夛細`AUTH_SECRET` 鍦?`.dev.vars` 閲岋紝鐢?HMAC-SHA256 绛?   `base64url(payload) + "." + base64url(sig)`锛宲ayload 鏄?`{v:1, iat, exp, jti}`锛屽甫 header
   `Cookie: ds_token=<token>`銆傚疄鐜拌 `src/auth.ts` 鐨?`signAuthToken`銆?
> 鍙湪鏈湴鐢ㄣ€傜敓浜х殑 `AUTH_SECRET` 鏄彟涓€浠斤紝绛句笉鍑烘潵鈥斺€旇繖鏈韩涔熸槸銆岄儴缃叉槸鍚︾敤瀵瑰瘑閽ャ€嶇殑妫€楠屽姙娉曘€?
## 5. 鏁版嵁瀹夊叏

- 蹇収閲屾湁鐪熷疄瀵硅瘽锛?`tmp/` 涓?`.wrangler/` 宸插啓杩?`.gitignore`锛?- 璋冭瘯瀹?`Remove-Item -Recurse .\tmp`锛?- 涓嶈鎶?`wrangler.local.toml`锛堝惈璧勬簮 id锛夊拰 `.dev.vars`锛堝惈瀵嗛挜锛夋彁浜ゃ€?
## 6. 宸查獙璇?
2026-10-31 瀹炴祴锛氬鍏?276 鏉℃秷鎭?+ 21 寮犺〃 鈫?`/api/health` 鍏?ok锛坉1/kv/r2 鏈湴鍧囬€氳繃锛夆啋
`/api/admin/requests` 杩斿洖 200锛屼笖 `request_log` 琚儼鎬у缓濂姐€佸啓鍏ヤ簡 3 琛屻€