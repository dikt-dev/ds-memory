# 文件读取给小忆（AstrBot 插件）

让小忆能读懂你在 QQ 里发来的**文件**——包括 DeepSeek 本身处理不了的 **PDF / Word / Excel / PPT**。

## 为什么需要这个插件

小忆跑在 Cloudflare Workers 上，而文件在 **AstrBot 所在的机器**（比如 `/root/data/temp/xxx.txt`）。
Worker 拿不到这个本地路径，所以 AstrBot 传过去的内容只有「文件名 + 路径」，模型看不到文件内容。

这个插件在 **AstrBot 侧**把文件读出来 / 解析成文字，作为额外内容注入到发给模型的请求里 —— 模型于是能"看到"文件。

## 支持的格式

### 文本类（直接读取，无需额外依赖）

```
.txt .md .json .log .csv .yml .yaml .toml .ini .conf .xml
.html .css .js .ts .py .c .h .cpp .java .go .rs .sql .sh
```

### 文档类（走解析库，转成文本）

| 格式 | 解析库 | 说明 |
|------|--------|------|
| `.pdf` | `pypdf` | 提取文字；扫描件/图片型 PDF 提取不到文字会提示 |
| `.docx` | `python-docx` | 段落 + 标题 + 表格 |
| `.xlsx` | `openpyxl` | 每个工作表逐行转 `单元格 | 单元格`，单表最多 500 行 |
| `.pptx` | `python-pptx` | 每页文本框里的文字 |

### 不支持

- `.doc` / `.xls` / `.ppt`（旧版二进制格式）—— 请在 Office/WPS 里另存为 `.docx/.xlsx/.pptx`
- 图片 —— 不需要插件，AstrBot 传图片时走视觉理解

## 安装

1. 把 `astrbot_plugin_file_reader` 文件夹放进：

```
AstrBot/data/plugins/astrbot_plugin_file_reader/
├── main.py
├── metadata.yaml
├── _conf_schema.json
├── requirements.txt
└── README.md
```

2. **安装依赖**（解析 PDF/Word/Excel/PPT 必需）：

```bash
# 进入 AstrBot 使用的 Python 环境
pip install -r AstrBot/data/plugins/astrbot_plugin_file_reader/requirements.txt
```

或者用 AstrBot 的容器：

```bash
docker exec -it <容器名> pip install pypdf python-docx openpyxl python-pptx
```

> AstrBot 的部分版本会在安装/更新插件时自动读取 `requirements.txt` 并安装依赖。
> 如果解析时报"缺少 xxx 库"，手动执行上面的 pip 命令即可。

3. 重启 AstrBot（或 WebUI「插件管理」里重载插件）。

## 配置

| 配置项 | 默认 | 说明 |
|--------|------|------|
| `enable` | 开 | 总开关 |
| `max_chars` | 16000 | 单文件最多注入多少字符，超出截断 |
| `allowed_ext` | 见上 | 允许读取的扩展名，逗号分隔 |

## 怎么验证生效

在 QQ 里发一个 `.txt` / `.pdf` / `.docx` 文件，然后问"这个文件写了什么"。
AstrBot 日志应出现：

```
[文件读取] 已注入 1 个文件内容（约 xxx 字）
```

如果没生效，检查：

1. 插件是否已启用、配置里 `enable` 是否为开
2. AstrBot 日志有没有 `[文件读取]` 开头的报错
3. 文档类文件是否装了对应的解析库（报错会直接告诉你缺哪个）

## 工作原理

```
用户发文件
  ↓
AstrBot 收到消息（含 file 组件 / File Attachment 标记）
  ↓
本插件在 on_llm_request 钩子里：
  1. 从消息链/消息文本里提取文件真实路径
  2. 按扩展名分派：
     - 文本类 → 解码（UTF-8/GB18030 自动识别）
     - pdf/docx/xlsx/pptx → 调解析库转成文字
  3. 截断到 max_chars
  ↓
把内容作为 <file_content> 注入到本轮 LLM 请求
  ↓
小忆（Worker 上的模型）就能读到文件内容
```

## 前提：AstrBot 版本

需要 **AstrBot >= 4.16**（依赖 `@filter.on_llm_request` 钩子和 `TextPart`）。
如果版本太旧，日志会提示"当前 AstrBot 版本不支持 TextPart"。

## 已知限制

- PDF 只提取**文字层**。扫描件、图片型 PDF 需要 OCR，本插件不含 OCR。
- PDF 最多扫描前 300 页（防图片型 PDF 遍历上千页卡死）。
- Excel 单表最多取 500 行，PPT/PDF 有总量保护，防止超长文件把上下文撑爆。
- 单个文件上限 2MB。

## 路径识别规则

插件会从三个来源找文件，但**优先用明确标记**，避免误读聊天里提到的路径：

| 来源 | 是否要求扩展名 | 说明 |
|---|---|---|
| 消息链 File 组件 | 否 | 适配器给出的真实路径，最可靠 |
| `[File Attachment: ...]` 标记 | 否 | AstrBot 自己生成的附件标记 |
| 裸路径兜底 | **是** | 必须在 `root/tmp/home/data/var` 下，且以已知扩展名结尾 |

> 之所以对裸路径要求扩展名：你在聊天里说「我把项目放在 `/home/me/project` 里了」，
> 那只是一个目录名，不应该被当成文件去读、再回一句「读取失败」。

同一文件从多个来源以不同写法出现时（`/root/a.txt`、`/root/./a.txt`）
会先归一化再去重，不会重复注入。

## 配置容错

| 配置项 | 非法时的行为 |
|---|---|
| `max_chars` | 非数字→回退 16000；过小→抬到 1000；过大→压到 200000 |
| `allowed_ext` | 写成 `txt` 或 `.txt` 均可，自动补点并去空白 |
| `enable` | 关掉后完全跳过注入，不读任何文件 |

## 许可

MIT
