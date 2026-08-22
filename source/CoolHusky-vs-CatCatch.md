# CoolHusky vs Cat-Catch 全面对比分析报告

> 分析日期：2026-08-21
> 对比对象：本项目 `cool-husky`（lyove/cool-husky）vs 同目录 `cat-catch`（xifangczy/cat-catch v2.7.2）
> 分析方法：基于双方全部核心源码的一手阅读

---

## 一、项目概览

| 维度 | CoolHusky（本项目） | Cat-Catch |
|------|---------------------|-----------|
| 定位 | 现代化 WebExtension 脚手架 + 媒体嗅探下载 | 成熟的媒体抓取下载工具（老牌插件） |
| 技术栈 | Vite 7 + React 19 + TypeScript 5.9 + SCSS Modules + hls.js/dashjs/mpegts.js（播放）+ mediainfo.js（WASM 元数据） | 原生 JS + jQuery + HTML 多页面 + hls.js/mux.js/mqtt.js |
| Manifest | MV3（Chrome/Firefox 双构建） | MV3（Chrome）/ MV2（Firefox，manifest.firefox.json） |
| 源码规模 | ~10,500 行 TS（Background 3537 + Popup 2485 + injected 1434 等） | ~9,500 行 JS（background 1126 + m3u8 2353 + popup 1154 + preview 1118 等） |
| 浏览器支持 | Chrome 102+ / Firefox 112+ / Edge / Brave / Opera | Chrome 93+ / Firefox / Edge |
| 版本 | 0.0.0（早期） | 2.7.2（成熟） |

---

## 二、功能矩阵对比

### 2.1 双方共有的核心功能

| 功能 | CoolHusky | Cat-Catch |
|------|-----------|-----------|
| webRequest 媒体嗅探 | ✅ | ✅ |
| URL/Content-Type 识别 | ✅ 三重（URL+Type+Disposition） | ✅ 双重（扩展名+Type）+ 正则 |
| 大小过滤 | ✅ 按 6 大类分组 | ✅ 每个扩展名/类型独立配置 |
| M3U8/HLS 解析 | ✅ 解析+估算大小 | ✅ 解析+**完整下载+解密+合并** |
| MPD/DASH 解析 | ✅ 解析+变体识别 | ✅ 解析+下载（mpd-parser.min.js） |
| MSE 捕获 | ✅ Proxy addSourceBuffer | ✅ 录制式（recorder.js） |
| 请求头注入（Referer/Auth） | ✅ declarativeNetRequest | ✅ declarativeNetRequest + webRequestBlocking |
| 代理下载（绕跨域） | ✅ PROXY_FETCH | ✅ 内置下载器 |
| 预览播放 | ✅ MediaPlayerModal + InlinePlayer（hls.js/dashjs/mpegts.js 播放 HLS/DASH/FLV） | ✅ preview.html（1118 行，hls.js 播放+跨 tab 控制，功能更全） |
| 国际化 i18n | ✅ _locales + i18n.ts | ✅ _locales（多语言） |
| 侧边栏 | ✅ Chrome sidePanel + Firefox sidebar | ✅ side_panel（popup.html 复用） |
| 图标徽章计数 | ✅ updateBadge | ✅ SetIcon |

### 2.2 Cat-Catch 独有功能（本项目暂无）

| 功能 | 实现位置 | 说明 |
|------|----------|------|
| **M3U8 完整下载合并** | m3u8.js (2353行) + m3u8.downloader.js | 多线程并发（M3u8Thread=6）、AES-128 解密（AESDecryptor）、SAMPLE-AES-CTR、自定义 key、TS→MP4 转封装（mux.js/transmuxer）、ffmpeg 在线转码 |
| **录屏** | recorder.js / recorder2.js | MediaRecorder API + 可选 ffmpeg 转码，码率/帧率可调 |
| **WebRTC 流捕获** | webrtc.js | 捕获 WebRTC 视频轨道并录制 |
| **深度搜索** | search.js (867行) | 扫描 DOM video/audio/source + Worker + iframe + postMessage + Base64/Hex 解码，远超普通嗅探 |
| **Aria2 推送下载** | init.js + downloader.js | aria2Rpc 远程下载 |
| **MQTT 推送** | init.js + lib/mqtt.min.js (369KB) | 抓取结果推送到 MQTT 主题 |
| **send2local 本地推送** | init.js | HTTP POST 到本地服务 |
| **模拟手机 UA** | background.js mobileUserAgent | declarativeNetRequest 改 UA 获取移动端视频 |
| **m3u8dl 协议调用** | init.js m3u8dl/m3u8dlArg | 调用本地 m3u8dl CLI 工具 |
| **8 个快捷键命令** | manifest.json commands | enable/auto_down/catch/m3u8/clear/reboot/deepSearch/preview |
| **右键菜单** | contextMenus 权限 | 可配置右键菜单项 |
| **正则规则引擎** | G.Regex（含 blackList） | 用户自定义正则匹配/屏蔽 URL |
| **二维码** | lib/jquery.qrcode.min.js | 生成 URL 二维码 |
| **JSON 查看器** | lib/jquery.json-viewer.js + json.html | 查看/格式化 JSON |
| **媒体控制** | media-control.js (275行) | 网页内媒体播放控制 |
| **自动下载** | featAutoDownTabId | 抓到即自动下载 |
| **强制屏蔽网站** | damn/damnUrlSet | 强制不抓取指定站点 |
| **在线 ffmpeg** | iframeFFmpeg | iframe 内嵌入在线 ffmpeg |
| **StreamSaver 流式保存** | lib/StreamSaver.js | 边下边存，突破内存限制 |
| **网页 DOM 获取** | getHtmlDOM | 实验性获取当前网页 DOM |

### 2.3 CoolHusky 独有功能（Cat-Catch 暂无）

| 功能 | 实现位置 | 说明 |
|------|----------|------|
| **Bilibili DASH 深度适配** | injected.ts + upsertBilibiliDashTask | 解析 `__INITIAL_STATE__`，按 cid/ep_id 路由，视频+音频独立轨道归组，估算合并大小 |
| **抖音/TikTok 专门适配** | douyin.ts (284行) + platform-media.ts | 深度遍历页面 JS 对象（playaddr/play_addr/url_list 等），提取多清晰度候选，域名白名单校验 |
| **MediaInfo WASM 元数据检测** | Background fetchMediaInfo + MediaInfoModule.wasm | 通过 WASM 精确读取宽高/时长，带正负缓存+LRU 淘汰 |
| **音频合并 WAV** | audio-merge.ts (177行) | AudioContext + OfflineAudioContext 混音，支持多格式重采样合并 |
| **MSE 数据重建下载** | injected.ts MSE hook | Proxy 拦截 appendBuffer 累积原始分片，可下载重建（MSE_CAPTURE_MAX=8） |
| **图片 DOM 提取器** | image-extractor.ts (290行) | 扫描 img/picture/object/embed + CSS background/mask/lazy-load 属性 |
| **批量元数据并发探测** | GET_MEDIA_METADATA_BATCH | mapWithConcurrency 6 并发，批量补全宽高/时长/大小 |
| **虚拟列表渲染** | Popup VirtualList | ResizeObserver + 动态高度，长列表流畅 |
| **流分组归并显示** | master/variant/segment groupRole | M3U8 master+变体+分片自动归组，避免列表爆炸 |
| **DRM 检测** | PREPARE_MEDIA_PLAYBACK | 检测 ContentProtection/widevine/playready/cenc:pssh |
| **跨站点导航清理** | isSameSite + pendingNavigationCheck | 同站点 SPA 导航保留，跨站点自动清空 |
| **SidePanel/Popup 双模式** | openMode 设置 | 用户可在侧边栏与弹窗间切换 |
| **数据持久化恢复** | loadAllTabData + media-storage.ts | SW 重启后从 storage.local 恢复嗅探列表 |
| **TypeScript 类型安全** | 全量 TS | 编译期错误检查 |

---

## 三、核心机制实现差异深度对比

### 3.1 媒体嗅探捕获机制

#### webRequest 监听策略

| 项 | CoolHusky | Cat-Catch |
|----|-----------|-----------|
| 监听事件 | `onSendHeaders` + `onHeadersReceived` + `onBeforeSendHeaders` + `onCompleted` + `onErrorOccurred` | `onSendHeaders` + `onResponseStarted` + `onErrorOccurred` |
| 关键差异 | 用 `onHeadersReceived`（响应头完整），过滤更准 | 用 `onResponseStarted`（首字节即触发，更早） |
| extraInfoSpec | Chrome: `['requestHeaders','extraHeaders']`；Firefox: `['requestHeaders']` | `['requestHeaders', EXTRA_HEADERS]` |
| 优点 | 响应头全，content-type/length/disposition 同时可得 | 触发早，延迟低 |
| 缺点 | 略晚（等响应头） | 部分响应头可能未就绪 |

#### 请求过滤与去重

**CoolHusky**（`scripts/background/index.ts`）：
- `processedRequests` Set（key=`tabId:url`，上限 10000，FIFO 淘汰）
- `tabMap.get(tabId).get(url)` 二级去重
- `isPotentialMediaRequest` 正则预过滤（m3u8/mp4/mp3 等扩展名）
- `isMediaSegmentRequest` 排除分片（m4s/ts 等）
- `details.type` 过滤掉 main_frame/script/stylesheet/font/image/ping

**Cat-Catch**（`background.js` findMedia）：
- `G.urlMap` = `Map<tabId, Set<url>>` 指纹去重（>500 自动清空避免内存）
- `CheckExtension(ext, size)` → 31 种扩展名 Map，每个可独立开关+大小阈值
- `CheckType(type, size)` → 9 种 content-type Map，支持 `audio/*`/`video/*` 通配
- `G.Regex` 正则引擎（可 blackList 屏蔽）
- `data.type == "media"` 无条件放行

**核心差异**：
| 维度 | CoolHusky | Cat-Catch |
|------|-----------|-----------|
| 去重粒度 | tabId+url 精确去重 | tabId+url（>500 条停止去重以保性能） |
| 去重容量 | 10000 条（FIFO 淘汰） | 500 条/标签页（满后清空） |
| 过滤配置 | 6 大类开关+每类最小大小 | 每个扩展名/类型独立开关+独立大小+运算符 |
| 默认大小过滤 | video=100KB, audio=1KB, image=10KB | 默认 size=0（不过滤） |
| 过滤返回值 | 布尔（允许/拒绝） | 三态（false/true/"break"），禁用类型直接中断处理 |
| 灵活度 | 较粗（6 类） | 极细（31 扩展名 + 9 类型 + 正则） |
| 正则引擎 | ❌ | ✅ 用户自定义，支持 blackList 动态屏蔽 |
| 分片处理 | 排除 m4s/ts，归组到 master | m4s/ts 默认 state:true 可抓 |

#### 媒体类型识别

**CoolHusky**（`detect.ts`，603 行）：
- `MEDIA_FORMATS`：40+ content-type → format 映射
- `EXTENSION_MAP`：27 种扩展名
- `detectMedia()` 优先级：排除分片 → octet-stream 特殊处理（CDN 识别）→ content-type → URL → Content-Disposition
- `isKnownMediaCdn`：5 类 CDN 域名正则（抖音/字节/快手/腾讯/喜马拉雅）
- `detectDoc`：PDF/Word/Excel/PPT/字幕 识别
- `MIN_OCTET_STREAM_SIZE = 1MB`：避免小 octet-stream 误判

**Cat-Catch**（`init.js` + `background.js`）：
- `G.Ext`：31 种扩展名（含 hlv/f4v/wma/asf/divx/vid/opus 等冷门格式）
- `G.Type`：9 种 content-type（含 `application/octet-stream-m3u8` 特殊类型）
- `fileNameParse`：URL 路径解析文件名+扩展名
- `getResponseHeadersValue`：解析 content-length/type/disposition/range
- octet-stream：`application/octet-stream-m3u8` 特殊处理

**差异**：Cat-Catch 覆盖格式更广（含 wmv/asf/divx/hlv 等老格式），CoolHusky 更聚焦现代格式但加了 CDN 域名识别（对抖音/字节系更准）。

#### MSE/EME 捕获

**CoolHusky**（`injected.ts`，Proxy 方式）：
- `MediaSource.prototype.addSourceBuffer` 用 Proxy 拦截
- `SourceBuffer.prototype.appendBuffer` 拦截，累积原始分片（`MSE_SEGMENT_SIZE=1GB` 分段）
- `endOfStream` 拦截标记完成
- 通过 `COOLHUSKY_MSE_STREAM_UPDATE` 消息回传
- `MSE_CAPTURE_MAX=8` 上限，LRU 淘汰
- **MessageChannel 零拷贝传输** ArrayBuffer
- **可下载重建**（MSE_DOWNLOAD 触发，创建 `mse://` 伪 URL）

**Cat-Catch**（`catch.js` Proxy + `recorder.js` 录制，双方案）：
- Proxy 方案同样拦截 `addSourceBuffer`/`appendBuffer`/`endOfStream`，缓冲数据存 `catchMedia` 数组（无上限）
- 支持**自动下载 + FFmpeg 多轨合并**
- 通过 blob URL 下载
- `recorder.js`：`MediaRecorder` API 录制 video 元素流，可选 ffmpeg 转码
- 码率（2.5/5/8/16 Mbps）/帧率（25/30/60/120 FPS）可调，1 小时自动保存
- recorder2.js 另一种实现

**差异**：CoolHusky 是**数据级捕获**（Proxy 重建原始分片，质量无损），有内存上限管理（8 个/1GB）和零拷贝传输优化，但无自动合并。Cat-Catch 同时提供 Proxy 捕获（支持自动下载+FFmpeg 合并）和录制式捕获（二次编码有损但兼容性好），方案更完整。两者 MSE Proxy 思路相同，但 Cat-Catch 多了录制兜底和合并能力。

#### 深度搜索

**CoolHusky**：无独立深度搜索，但 `injected.ts` 做了页面级 hook：
- XHR.open/send、fetch、HTMLMediaElement.src setter 拦截
- DOM MutationObserver 监听 video/audio/source 元素添加
- iframe sandbox 移除（允许 hook iframe 内媒体）
- SPA 导航跟踪（history.pushState/replaceState）
- 平台特定解析：Bilibili DASH（解析 `__INITIAL_STATE__`）、抖音 aweme（遍历 play_addr 等字段）
- 主要靠被动嗅探 + 针对性平台 hook

**Cat-Catch**（`search.js`，867 行，MAIN world 注入）：
- **hook 约 20 个底层 JS API**：XHR、fetch、JSON.parse、TextDecoder、btoa/atob、String.fromCharCode、TypedArray 构造器/subarray、DataView、Array.slice/join、Worker 构造器、String.indexOf、escape 等
- **Worker 注入**：将 search.js 代码注入 Web Worker 内部，捕获 worker 中的媒体 URL/密钥
- DOM 扫描：script 标签内正则匹配 m3u8/mp4/flv URL
- Base64/Hex 解码检测
- Vimeo CDN 特殊处理
- **反检测**：所有 hook 函数 `toString()` 伪装为原函数，修复被劫持的 console.log
- 可通过 `deepSearch` 命令常开

**差异**：Cat-Catch 的深度搜索远比 CoolHusky 激进——深入到序列化/编解码层（JSON.parse、TypedArray、DataView），且能注入 Web Worker，配合 toString 反检测。CoolHusky 的 hook 集中在网络请求层 + 平台特定解析，未深入到编解码层。Cat-Catch 能发现 webRequest 和普通 hook 都抓不到的（JS 动态拼接、Worker 内部、加密密钥）。

---

### 3.2 下载与流媒体处理

#### M3U8/HLS

| 维度 | CoolHusky | Cat-Catch |
|------|-----------|-----------|
| 解析 | `parseM3U8Manifest`：master/media 识别、变体排序、音频组 URI | hls.js（lib/hls.min.js 543KB）完整解析 |
| 下载 | ❌ **仅捕获 URL，不下载合并** | ✅ m3u8.downloader.js 多线程并发（thread=6） |
| 解密 | ❌ | ✅ AESDecryptor（AES-128 + SAMPLE-AES-CTR + 自定义 key） |
| 转封装 | ❌ | ✅ mux.js（TS→MP4）+ transmuxer |
| ffmpeg | ❌ | ✅ 在线 ffmpeg + 本地 m3u8dl 协议 |
| 大小估算 | ✅ 分片四分位采样估算 | ✅ 实际下载得真实大小 |
| 流式保存 | ❌ | ✅ StreamSaver.js 边下边存 |
| 失败重试 | ❌ | ✅ 500ms * retryCount 退避重试 |

**关键差距**：这是两者最大的功能差距。CoolHusky 的 `stream-parser.ts` 只做**解析+估算**（441 行），不实际下载合并 TS。Cat-Catch 的 `m3u8.js`（2353 行）+ `m3u8.downloader.js` 是完整的下载器，支持解密、转封装、并发、重试、流式保存。

#### MPD/DASH

| 维度 | CoolHusky | Cat-Catch |
|------|-----------|-----------|
| 解析 | `parseDashManifest`：正则提取 AdaptationSet/Representation | mpd-parser.min.js（专业库） |
| Bilibili 特化 | ✅ `upsertBilibiliDashTask`：解析 `__INITIAL_STATE__`，视频+音频归组，估算大小 | ❌ 通用处理 |
| 下载合并 | ❌ 仅展示 | ✅ 下载+合并 |

#### 下载机制

**CoolHusky**：
- `chrome.downloads` API（常规下载）
- `PROXY_FETCH`：经 Background 代理 fetch（绕 CORS），base64 回传，用于音频合并/元数据
- `ensureProxyHeaderRule`：declarativeNetRequest 注入 Referer/Auth/移除 Origin，sessionRules（上限 5000，LRU 淘汰）
- `fetchContentLength`：HEAD + Range 双策略探大小

**Cat-Catch**：
- `chrome.downloads` + 自定义下载器（downloader.js）
- StreamSaver.js 流式保存（突破 chrome.downloads 内存限制，chromeLimitSize=1.8GB）
- Aria2 RPC 推送
- send2local HTTP 推送
- m3u8dl CLI 协议调用
- 自动下载（featAutoDownTabId）

**差异**：Cat-Catch 下载渠道更多元（浏览器/Aria2/本地 CLI/流式），CoolHusky 主要靠 chrome.downloads + 代理 fetch。

#### 音视频合并

**CoolHusky**（`audio-merge.ts`）：AudioContext decodeAudioData + OfflineAudioContext 混音 → audiobuffer-to-wav。支持 mp3/m4a/oga/weba/wav/flac/aac/ogg/opus，自动重采样。仅**音频合并**。

**Cat-Catch**：mux.js（TS→MP4 转封装）+ ffmpeg（视频合并/转码）。支持**视频+音频合并**。

#### DRM/加密

**CoolHusky**：`PREPARE_MEDIA_PLAYBACK` 检测 `ContentProtection|widevine|playready|cenc:pssh`，返回 drm 标志（仅检测不破解）。

**Cat-Catch**：支持 AES-128/SAMPLE-AES-CTR 解密（HLS 加密，用 AESDecryptor + 自定义 key）。对 DRM 视频同样无法破解 CDM，但 `search.js` 有 **16 种 DRM 密钥检测路径**（通过 hook TypedArray/DataView/btoa/atob/String.fromCharCode 等深度提取密钥），路线比 CoolHusky 激进得多。CoolHusky 仅检测 DRM 标志位是否存在，不尝试提取密钥。

**差异**：两者都无法破解 Widevine/PlayReady 等硬件级 DRM。但在 HLS 加密层面 Cat-Catch 可解密，且对密钥提取的尝试远比 CoolHusky 深入。

---

### 3.3 UI 界面与设置系统

#### UI 架构

**CoolHusky**：React 19 + TypeScript + SCSS Modules + Vite HMR。Popup（2485 行）含虚拟列表、MediaPlayerModal、InlineMediaPlayer、SettingsView、Tooltip 等组件化架构。SidePanel/Popup 双模式（openMode 设置）。

**Cat-Catch**：原生 JS + jQuery + 多 HTML 页面（popup/options/m3u8/mpd/preview/downloader/json/install）。popup.html 同时用于 action popup 和 side_panel。options.html 40KB，设置极丰富。

**差异**：CoolHusky 现代化、组件化、类型安全，但 UI 功能密度低于 Cat-Catch。Cat-Catch 虽技术栈老但功能页面多、设置项极丰富。

#### 设置系统

**CoolHusky**（`settings.ts`，9 项配置）：
- sniffingRules（6 类开关+最小大小）
- excludeDomains、maxItems、enableMseCapture、hideStreamSegments、captureDataImages、dataImageMinSizeKB、openMode

**Cat-Catch**（`init.js`，50+ 项配置）：
- Ext/Type/Regex 三套规则（每项独立开关+大小+运算符）
- 下载：saveAs/catDownload/downStream/downFileName/userAgent
- Aria2：aria2Rpc/token/dir/enableReferer
- MQTT：broker/port/topic/qos/clientId/user/pass
- send2local：URL/method/body/headers
- m3u8：M3u8Thread/M3u8Mp4/M3u8OnlyAudio/M3u8SkipDecrypt/M3u8StreamSaver/M3u8Ffmpeg/M3u8AutoClose
- m3u8dl：m3u8dl/m3u8dlArg/m3u8dlConfirm
- UI：popup/popupMode/badgeNumber/ShowWebIco/reverse/sidePanel
- 功能：enable/checkDuplicates/autoClearMode/deepSearch/damn/contextMenus
- 播放：playbackRate/Player
- 复制模板：copyM3U8/copyMPD/copyOther
- 屏蔽：blockUrl/blockUrlWhite
- 模拟手机：MobileUserAgent

**差异**：Cat-Catch 设置项数量是 CoolHusky 的 5 倍以上，可配置性远超。CoolHusky 走"合理默认+少配置"路线。

#### 快捷键/右键/国际化

| 项 | CoolHusky | Cat-Catch |
|----|-----------|-----------|
| commands 快捷键 | ❌ | ✅ 8 个（enable/auto_down/catch/m3u8/clear/reboot/deepSearch/preview） |
| contextMenus | ❌ | ✅ 可配置 |
| i18n | ✅ _locales（9 种语言：en/zh_CN/zh_TW/de/es/ja/ko/ru） | ✅ _locales（11 种语言：en/es/fr/ja/ko/pt_BR/ru/tr/vi/zh_CN/zh_TW） |

---

## 四、优缺点总结

### 4.1 CoolHusky（本项目）

**优点：**
1. **现代技术栈**：React 19 + TypeScript + Vite，类型安全、HMR、组件化，可维护性强
2. **跨浏览器统一**：webextension-polyfill + Vite 多目标构建，一套代码出 Chrome/Firefox
3. **平台适配精准**：Bilibili DASH（按 cid/ep_id 路由）、抖音/TikTok（深度对象遍历+域名白名单）做得比 Cat-Catch 深入
4. **MSE 无损捕获**：Proxy 拦截 appendBuffer 重建原始分片，质量无损（Cat-Catch 是有损录制）
5. **元数据精确**：MediaInfo WASM 读取真实宽高/时长，带缓存优化
6. **流分组归并**：master/variant/segment 三级归组，列表整洁
7. **工程细节扎实**：LRU 淘汰、负缓存、防抖广播、SW 重启恢复、跨站点导航清理
8. **音频合并**：AudioContext 方案支持多格式重采样

**缺点：**
1. **核心下载能力缺失**：M3U8 不下载合并、不解密、不转封装——这是视频抓取插件的**核心痛点**，用户抓到 m3u8 却无法直接得到 mp4
2. **功能广度不足**：无录屏、无 WebRTC、无深度搜索、无 Aria2/MQTT/本地推送、无模拟手机 UA、无快捷键、无右键菜单
3. **设置项过少**：用户可控维度少，无法精细调节每个格式
4. **正则规则缺失**：无法自定义 URL 匹配/屏蔽规则
5. **无 StreamSaver**：大文件下载受 chrome.downloads 内存限制
6. **版本早期**（0.0.0），成熟度不足

### 4.2 Cat-Catch

**优点：**
1. **功能极全面**：录屏/WebRTC/深度搜索/Aria2/MQTT/send2local/m3u8dl/模拟手机/正则规则，覆盖几乎所有媒体抓取场景
2. **M3U8 下载完整**：多线程并发+AES 解密+自定义 key+TS→MP4 转封装+ffmpeg+流式保存+重试，工业级
3. **设置极丰富**：50+ 配置项，三套规则引擎（Ext/Type/Regex），每项独立开关+大小+运算符
4. **下载渠道多元**：浏览器/Aria2/本地 CLI/流式/自动下载
5. **快捷键+右键菜单**：操作效率高
6. **成熟稳定**（v2.7.2，长期迭代）

**缺点：**
1. **技术栈老旧**：原生 JS + jQuery，无类型检查、无组件化、无 HMR，维护成本高
2. **MSE 捕获有损**：MediaRecorder 录制式，二次编码有质量损失（CoolHusky 是无损重建）
3. **平台适配泛化**：无 Bilibili/抖音的深度特化，靠通用嗅探+深度搜索
4. **无 MediaInfo 精确元数据**：宽高/时长靠响应头/估算
5. **代码组织松散**：全局变量 G + 多 HTML 页面，状态管理混乱
6. **依赖第三方大库**：jquery(78KB)+hls.js(543KB)+mqtt(369KB)+mux(116KB)，包体积大
7. **无音频合并**（靠 ffmpeg）
8. **Firefox 仍用 MV2**（manifest.firefox.json），未来兼容性风险

---

## 五、关键结论与建议

### 5.1 核心差距

两者最大差距在**M3U8/HLS 下载链路**：CoolHusky 只做到"发现+解析+估算"，Cat-Catch 做到"发现+下载+解密+转封装+合并"的完整闭环。这直接决定用户能否拿到最终视频文件。

第二大差距在**功能广度**：Cat-Catch 有 20+ 项独有功能（录屏/WebRTC/深度搜索/远程推送等），CoolHusky 走精简路线。

### 5.2 CoolHusky 的差异化优势

CoolHusky 并非全面落后，在以下方面**优于 Cat-Catch**：
- Bilibili/抖音平台适配深度
- MSE 无损捕获（vs 有损录制）
- MediaInfo WASM 精确元数据
- 流分组归并显示
- 现代技术栈可维护性
- 跨浏览器 MV3 统一（Firefox 也用 MV3）

### 5.3 给本项目的改进建议（按优先级）

| 优先级 | 建议项 | 参考实现 |
|--------|--------|----------|
| P0 | **补齐 M3U8 下载合并**：多线程并发下载 TS + 合并为 mp4 | cat-catch m3u8.downloader.js + mux.js |
| P0 | **补齐 HLS 解密**：AES-128/SAMPLE-AES + 自定义 key | cat-catch lib/m3u8-decrypt.js |
| P1 | **TS→MP4 转封装**：引入 mux.js，免 ffmpeg 依赖 | cat-catch lib/mux.min.js |
| P1 | **StreamSaver 流式保存**：突破大文件内存限制 | cat-catch lib/StreamSaver.js |
| P1 | **深度搜索**：DOM/Worker/iframe/postMessage 主动扫描 | cat-catch search.js |
| P2 | **正则规则引擎**：用户自定义 URL 匹配/屏蔽 | cat-catch G.Regex |
| P2 | **快捷键命令**：8 个核心操作快捷键 | cat-catch manifest.json commands |
| P2 | **右键菜单** | cat-catch contextMenus |
| P2 | **设置项扩展**：每格式独立开关+大小+运算符 | cat-catch Ext/Type Map |
| P3 | **Aria2/send2local 远程下载** | cat-catch init.js |
| P3 | **模拟手机 UA**：获取移动端视频 | cat-catch mobileUserAgent |
| P3 | **自动下载** | cat-catch featAutoDownTabId |

> 注：录屏/WebRTC/MQTT 等功能属于长尾需求，可视产品定位决定是否补充。CoolHusky 若聚焦"现代嗅探+无损 MSE+平台适配"的差异化定位，P0/P1 是必须补齐的，P2/P3 按需取舍。

---

*报告完*