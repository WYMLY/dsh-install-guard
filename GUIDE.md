
# 装东西之前先体检

主人让装东西的时候，别急着下载双击。这套流程是拿真事故换来的，四关走完再动手，五分钟能省掉一整晚。

## 什么时候必须跑

只要出现这些就要跑，不管主人催得多急：

- 「装一下」「部署一下」「下这个 exe / 安装包跑跑看」「npm i -g / pip install 这个东西」
- 「这个 GitHub 项目拿来用」「帮我 clone 下来跑」
- 别人发来的文件、压缩包、绿色版、破解版、某个网盘链接
- 给浏览器装扩展、给系统装驱动、给编辑器装插件

主人自己明确说「我知道没签名，就要跑」的时候可以放行，但要说清风险并留一份快照。

## 铁律

1. **先看再跑。** 未签名的大二进制，绝不先双击再说。
2. **跑之前先快照。** `scripts/snapshot.ps1` 抓一份，出事才追得回来。
3. **不认识的发布者 = 没资格拿到管理员。** 静默安装（`/S`、`/quiet`）一律先问。
4. **红档就停手。** 有红旗就回主人，别赌「应该没事」。
5. **报错退出 0 不等于装成功了。** 装完要核实：目录、进程、快捷方式、注册表条目，四样至少三样对上。
6. **命令行里的 `%ERRORLEVEL%` 不能信。** `cmd /c "a.exe & echo %ERRORLEVEL%"` 会在整行预处理时就展开，永远是旧值。要拿真 exit code 用 `Start-Process -Wait -PassThru` 读 `.ExitCode`。

## 第一关：卡源头（最便宜的一关）

这一步能砍掉大部分事故。那天假仓库的特征，三十秒就能看出来：

| 看什么 | 危险信号 |
| --- | --- |
| GitHub org 的 `created_at` | 和 repo 的 `created_at` 只差几分钟（临时建的号，一次性的） |
| org 的 `name` / `description` | 没有 display name、没有头像、描述空 |
| org 的 `public_repos` | 只有 1 个仓库 |
| repo 的 `description` | 和真项目一字不差（照抄） |
| repo 的内容 | 只有 README/LICENSE/docs 空壳，**没有源码目录**，却挂着 release |
| release 的资产 | 官方是 `setup.exe`，它是 `setup.7z`；资产名同名但格式不同 |
| release 的 author | login 是个陌生账号，不是 org 里的主号 |
| star / fork | 真项目 17k star，它 18 star、3 fork |

反向核实三件事，至少中两件才算真：

1. 官网 / 文档站是不是同一个域名、有没有链回这个仓库
2. npm registry（`https://registry.npmjs.org/<包名>`）或 PyPI 的 `repository` 字段指向谁
3. 搜「<项目名> github」时，正规来源写的是哪个 URL

工具：`api.github.com` 匿名会 403 限流，改用 `web_fetch` 打网页版，或者用 python `urllib` 加 Range 头拿 release 资产清单。

## 第二关：核文件（下载完、跑之前）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\inspect.ps1 -Path 'C:\path\to\thing.exe'
```

它会给出：大小、SHA256、Authenticode 签名状态、PE/安装器格式、Zone.Identifier、内嵌标记（NSIS / Inno / 7z / PyInstaller / Nuitka）、可读字符串里的 URL 与 IP。

判读方式：

- **SHA256 和官方公布值对不上 → 直接红，删掉。** 对得上才有资格进下一步。
- **未签名 ≠ 有毒。** 但「未签名 + 要管理员 + 广泛分发 + 只有二进制没源码」四条全占，按红处理。
- **加壳 / 混淆。** 4MB 内一个可读 URL 都没有，说明字符串被加密过。正经安装包挨这一条很可疑。
- **Nuitka / PyInstaller 打包的 exe** 自带一堆 `__pyinstaller` 之类的标记，能说明它其实是个 Python 程序，可以往这个方向验证。
- **Defender 不报毒 ≠ 干净。** 那批 payload 四个哈希，Defender 自定义扫描一个都没报。别拿「杀软没报」当结论。

## 第三关：跑之前先认红旗

这几条是那天真实命中的，任何一条都足以停手：

1. 打印「BOT DETECTION DETAILED REPORT」「等输入样本」「RDP Session: false」「threshold 120 points」这类**反分析自检**。
2. 采集并显示 **用户名、公网 IP、时间戳、版本号** 上报 telemetry。
3. 试图改 `HKLM\Software\Microsoft\Windows Defender\Spynet\DisableBlockAtFirstSeen`（关掉 Defender 的「首次见到就拦」）。
4. 把自己复制成 `C:\Program Files\<正经软件名>\<正经服务名>.exe`（空壳伪装目录：只有那一个 exe，没有其它文件）。
5. 把 payload 丢进 `C:\Users\Public\Music|Videos|<像样的名字>\...` 这种「用户可写、看着像系统组件」的位置。
6. 计划任务塞进 `\Microsoft\Windows\WindowsUpdate\`、`\Microsoft\Windows\CloudExperienceHost\` 冒充微软更新，author 写成 `Microsoft Corporation` / `Windows Publisher`，任务名末尾挂 8 位十六进制。
7. 同一个二进制换十几个名字（anydesk-host / caddy-host / gcloud-host / osqueryd / TeamViewer_Service / chef-client-service …），把文件时间戳改成一个月前。
8. 静默安装退出码 0 但什么都没装——它在做别的事，或它根本不是安装器。

## 第四关：装完做 diff

```powershell
# 装前
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\snapshot.ps1 -Out C:\tmp\before.json
# ...安装...
# 装后
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\snapshot.ps1 -Out C:\tmp\after.json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diff-snapshot.ps1 -Before C:\tmp\before.json -After C:\tmp\after.json
```

快照覆盖：计划任务（按**动作路径**存，别按 TaskPath 过滤）、服务与 ImagePath、HKLM/HKCU 的 Run/RunOnce、Startup 文件夹、WMI 事件订阅、监听端口与对外连接。

看 diff 时重点：

- 新冒出来的计划任务，动作指向 `C:\Users\Public\` 或 `AppData\Local\Temp` → 红。
- 新增服务里 ImagePath 落在用户可写目录 → 红。
- 新增一个只有 exe 的 `C:\Program Files\` 子目录 → 红。
- 装完程序列表、快捷方式、注册表 Uninstall 条目三样全无 → 它没装东西，去查它到底做了什么。

## 出结论：分档说人话

- **绿**：来源可核实、哈希对得上、有签名或源码可查、装完 diff 干净。→ 装，一句话交代。
- **黄**：来源可疑但风险有限（未签名的小工具、无源码但社区在用）。→ 先说清楚风险点，问过再装。
- **红**：冒名、哈希不符、反分析、改写安全设置、无授权自启。→ **停手**，把证据摆给主人：来源异常在哪、文件做了什么、需要删什么。

结论要写成主人能懂的话：「这个仓库是冒名的，装完会往系统里塞开机自启」比「命中 T1053.005」有用。

## 真中招了：处置顺序

1. **先取证再删。** `Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational'` 拉 1116 / 1117 / 1121 / 1122，看**发起进程**（`发起进程` 字段），这一步直接指认谁是放毒的。
2. 按 `Get-MpThreatDetection` 拿到路径与哈希。
3. **按哈希全盘扫**，别按名字找：`scripts\sweep-hash.ps1`。同一批货会换名字藏在别处。
4. 清自启：计划任务（`schtasks /delete /tn <全路径> /f`）、服务（`sc delete`）、Run/RunOnce 值、Startup 里的 .lnk 与 .vbs、WMI 订阅。
5. **再扫一遍全盘**，确认 0 命中。删完第一批就宣布「干净」是最容易翻车的地方——那天就有第二批 9 个文件、8 个计划任务。
6. 告诉主人泄露了什么（用户名、公网 IP 之类），建议换该换的密码。

### 提权脚本的坑

要管理员权限的清理：写 `.ps1` → `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',<ps1>`，脚本把结果写同目录 `.log`，回头读日志。

**脚本内容必须全是 ASCII。** 中文注释 + UTF-8 无 BOM，PowerShell 5.1 会按 ANSI 读，直接解析崩（报 `Unexpected token ')'`），表现像「UAC 根本没弹」「日志也没写」，很容易误判成权限问题。

## 本机的既有事实（省得每次重新踩）

- `npm.ps1` 被执行策略挡，用 `C:\Program Files\nodejs\npm.cmd`。
- pip 装不动的时候用 uv。
- `D:\dafeiyu-config-pack` 带拒删 ACE：Electron 类程序放这儿会 0x80000003 崩溃，装到 `%LOCALAPPDATA%\Programs` 才正常。
- 官方 NSIS 安装包在本机出现过「退出 0 但什么都没装」，原因未查明；遇到就走便携版 / npm / 解包的路子，并在结论里写明。
- `Start-Process -PassThru -Wait` 等大安装包会卡住 DSH 的 runner（子进程句柄），要 kill runner 才收尾；改用后台 job 或带超时的方式。

## 收尾

结论和哈希写进 `D:\dafeiyu-config-pack\dafeiyu-preset\memory.md`，下次遇到同名东西先翻一眼。
