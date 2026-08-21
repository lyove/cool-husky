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