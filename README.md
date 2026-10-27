# Discord Chat Translator（Discord 聊天翻译）

用于 Discord 网页端的聊天消息增强翻译用户脚本。架构沿用同系列的 [x-native-translator](https://github.com/Noctyn/x-native-translator) 与 [reddit-comment-translator](https://github.com/Noctyn/reddit-comment-translator)。由于 Discord 官方未内建消息翻译接口，脚本通过聚合多路免密钥公共翻译通道实现自动降级容错。


## 功能特性

- **多模式触发**：
  - **悬停翻译**：鼠标悬停于消息正文触发翻译，支持自定义延迟时间与 `Alt` / `Ctrl` / `Shift` 修饰键防误触。
  - **可视区域批量翻译**：点击右下角悬浮球 ⚡ 按钮或使用快捷键 `Alt + Shift + G`，一键翻译当前视口内所有消息。
  - **滚动自动翻译**（可选）：基于 `IntersectionObserver` + `400ms` 停留判定 + 限速队列，滚动浏览时自动翻译停留区域消息，快速滚过不触发请求。
- **三视图与三款外观**：
  - 单条译文卡片支持独立的「译文 / 对照 / 原文」分段切换，互不干扰。
  - 内置**色条引述**（默认）、**轻盈卡片**、**极简竖线**三款外观，深浅色主题自动跟随 Discord 客户端设置，支持一键关闭过渡动效。
- **多通道自动降级**：
  - 默认按 `Google (gtx)` → `Microsoft (Edge)` → `MyMemory` 顺序请求，均无需配置 API Key；单一通道连续失败时自动熔断拉黑并降级至备用通道。
- **深度适配 Discord 布局与虚拟列表**：
  - **双布局自适应**：Cozy（舒适）/ 网格布局下译文插入消息容器外部并对齐正文左缩进；Compact（紧凑）/ 块级布局下直接紧随正文之后。
  - **多行消息聚合**：同一条消息被拆分为多个 `message-content` 行节点时，自动按消息行与消息 ID 归并原文，合并请求并仅渲染一张译文卡片。
  - **虚拟列表重绘恢复**：Discord 滚动复用 DOM 节点时自动识别文本变更并重译；节点重绘导致译文卡片丢失时自动从缓存补齐。
- **缓存与交互细节**：
  - 内置本地 LRU 缓存（持久化保留 3 天），保留译文内超链接可点击，支持超长译文折叠展开、一键复制、失败重试及跨标签页配置同步。

---

## 安装与配置

### 安装

1. 请先在浏览器中安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)（推荐）或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 点击 [GitHub Raw 直链安装](https://raw.githubusercontent.com/Noctyn/discord-chat-translator/main/discord-chat-translator.user.js)（或新建脚本，粘贴 [`discord-chat-translator.user.js`](./discord-chat-translator.user.js) 源码保存）。
3. 打开或刷新 Discord 网页端，页面右下角出现悬浮按钮即代表加载成功。

> **跨域权限说明**：脚本通过 `GM_xmlhttpRequest` 发起跨域翻译请求，元数据已声明以下白名单域名：`translate.googleapis.com`、`clients5.google.com`、`edge.microsoft.com`、`api-edge.cognitive.microsofttranslator.com`、`api.mymemory.translated.net`。首次触发翻译时若脚本管理器弹出跨域授权提示，请选择「总是允许」。

### 快捷键

在聊天输入框聚焦打字时，不会误触以下快捷键与悬停翻译：

| 快捷键 | 功能说明 |
| :--- | :--- |
| `Alt + Shift + T` | 打开 / 关闭设置面板 |
| `Alt + Shift + A` | 开启 / 关闭滚动自动翻译 |
| `Alt + Shift + G` | 批量翻译当前屏幕可视区域内的所有消息 |
| `Alt + Shift + F` | 强制翻译当前鼠标悬停的消息（忽略同语种跳过规则） |
| `Alt + Shift + R` | 移除并还原当前页面所有已生成的译文 |

---

## 翻译通道说明

可在「设置 → 翻译 → 翻译通道」中手动锁定单一通道，默认设为「自动」（按表序依次降级，通道异常日志输出至控制台 `[Discord翻译]` 前缀）：

| 通道名称 | 译文质量 | 机制与限制说明 |
| :--- | :---: | :--- |
| **Google** | 佳 | 调用免密钥 `gtx` 前端接口；住宅宽带环境稳定，部分数据中心或共享代理出口可能触发 `429` 限流。 |
| **Microsoft (Edge)** | 佳 | 通过 `edge.microsoft.com/translate/auth` 换取临时凭证后调用 Cognitive Translator 接口，无需配置密钥。 |
| **MyMemory** | 中 | 免费公共翻译接口，单段上限 500 字符且频率限制较严，仅作为末级兜底通道。 |

---

## 实现机制

- **隐私与请求隔离**：脚本不读取 Discord 账号 Token 或 Cookie，也不调用任何 Discord 私有接口；仅提取页面渲染后的消息纯文本发送至所选翻译通道。
- **稳定 DOM 锚点**：规避随前端构建哈希频繁变化的混淆类名（如 `messageContent_c19a55`），仅依赖长期稳定的 ID 前缀约定：`div[id^="message-content-"]`（消息正文）与 `li[id^="chat-messages-"]`（消息行容器定位）。
- **网格与块级布局对齐**：当检测到消息正文父容器为 `flex` 或 `grid` 布局时，为防止译文卡片被当作新网格项撑乱排版，脚本会将卡片挂载于布局容器外侧，并动态计算正文左边界进行缩进对齐；普通块级布局则直接插入正文节点之后。
- **同消息多行归并**：针对部分布局将单条消息按换行拆分为多个 `message-content-<消息id>-<行号>` 节点的情况，脚本按所属消息行与主 ID 统一提取全文、统一控制原文显隐，避免逐行切碎翻译。

---

## 已知限制

- **公共接口限流**：Google 与 MyMemory 免费通道无 SLA 保障；全通道触发限流时脚本会自动暂停请求队列并弹出 Toast 提示，冷却恢复后点击重试即可。
- **富文本与特殊元素**：消息内的代码块、自定义表情名、`@提及` 会作为纯文本一并送翻（主流引擎通常会保留原样，但无法完全保证格式不发生偏移）。
- **非正文元素跳过**：仅翻译聊天消息正文；引用回复预览（Reply）、频道名称、用户昵称、系统通知与附件文件名均不在翻译范围内。
- **连续独立消息不合并**：若发送者分多次回车发出多条独立消息，脚本会按实际消息 ID 逐条独立翻译（单条消息内换行需发送者使用 `Shift + Enter`）。
- **选择器维护**：若未来 Discord 网页端重构移除了 `message-content-*` ID 命名规范，需同步更新脚本顶部的选择器常量。

---

## 开发与测试

本地测试套件位于 `.dev/` 目录（已在 `.gitignore` 中排除，不随仓库提交）：

- `fixture-discord.html`：覆盖 Discord Cozy、Compact 与网格三种消息布局的静态 DOM 测试夹具。
- `test-e2e-mock.py`：确定性端到端回归脚本。使用 `patchright` 启动 Chromium，注入 `GM_*` 兼容层（通过 `expose_binding` 将 `GM_xmlhttpRequest` 桥接至 Python 端以绕过浏览器 CORS），模拟通道故障链路（Google `429` → Microsoft `404` → MyMemory `200`），自动断言 19 项核心用例（批量翻译、通道降级、同语种跳过、三视图切换、工具栏、设置同步、还原、悬停触发、虚拟列表节点复用、多行消息聚合、嵌套节点去重与滚动自动翻译）。

执行测试：

```bash
uv run --with patchright python .dev/test-e2e-mock.py
```

测试运行截图与日志产物输出至 `.dev/browser-logs/`。

---

## 许可证

[MIT](LICENSE)
