# Install Guard · 安装前体检

装任何第三方东西之前，先让大肥鱼自己过一遍再动手。
四个机械动作加一份手册，全程只读：不删文件、不改设置、不联网查信誉、不发任何请求。

## 为什么有这玩意儿

2026-11-22 那天，一个仓库把自己伪装成开源项目 OpenMausBot：org 只建了 12 分钟、仓库 2 分钟后就推出来了、
README 照抄官方、release 里只挂一个未签名的 `.7z`。解压出来的 exe 会先做一轮反沙箱自检
（RDP 会话、虚拟机进程、核数、显存），然后上报用户名和公网 IP，再用静默安装退出 0 却什么都没装 ——
真正的活在别处：往 `C:\Program Files` 里塞 12 个换名的服务程序、往微软目录塞 12 个开机计划任务、
还顺手想把 Defender 的 `DisableBlockAtFirstSeen` 关掉。

这插件就是把那次事后总结的四道关固定下来。

## 五个动作

| action | 干什么 | 关键输出 |
| --- | --- | --- |
| `inspect` | 查一个已经下载下来的文件 | SHA256、签名主体、Zone.Identifier 下载标记、安装器格式（NSIS / Inno / PyInstaller / Nuitka / Electron）、内嵌 URL 与 IP、红旗字符串 |
| `snapshot` | 抓当前的自启与网络基线 | 计划任务 / 服务 / Run / Startup / WMI / 监听 / 外连 的数量与明细，存成 JSON |
| `diff` | 比对装前与装后两份基线 | 新增与消失的条目，指向用户可写目录的单独标出来 |
| `sweep` | 按哈希（可带尺寸）全盘找已知样本 | 命中清单；同一批货换名字藏在别处就靠它 |
| `guide` | 读完整检查清单 | 四关细节、红旗表、中招后的处置顺序 |

## 长什么样

```
━━ 安装前体检  inspect ━━
文件    C:\Users\wym\Downloads\setup.exe
大小    258.8 MB（271,338,829 字节）
指纹
SHA256  91FD8671CAA99BDA...
签名    Valid · CN=Microsoft Windows, O=Microsoft Corporation...
类型    二进制 · MZ/PE
安装器  是 · NSIS
下载标记 有 · ZoneId=3 / HostUrl=https://... / ReferrerUrl=https://...
内容
内嵌URL 8 条
        · https://example.com/update
内嵌IP  0 个
可疑串  没命中
```

```
━━ 差异  diff ━━

计划任务    新增 2 · 消失 0
  + \Microsoft\Windows\WindowsUpdate\ZoomLogonHelper98d6dbab  →  C:\Program Files\Zoom\zoom-service.exe   ⚠ 用户可写
服务        新增 1 · 消失 0
  + chef-client-service  →  C:\Program Files\Chef\chef-client-service.exe   ⚠ 用户可写

没变化      监听端口 · 对外连接

要看的      3 条指向用户可写目录：
  ! ...
```

## 怎么用

在 DSH 里直接说「装这个」「部署那个」，大肥鱼会先调 `install_guard`。
也可以手动点名：

- `install_guard action=inspect path=C:\Users\wym\Downloads\foo.exe`
- `install_guard action=snapshot` → 记住输出里的基线路径
- 装完之后 `install_guard action=snapshot`
- `install_guard action=diff before=<装前> after=<装后>`
- `install_guard action=sweep hashes=5AA51FBAA2D61ACF... sizes=3387424`

## 限制（别把它当杀软）

- 不联网查文件信誉、不看 VirusTotal，也不会替你决定「这个能不能装」。
- 不认识加壳后的内容：可读范围内抓不到 URL 不等于没有。
- `sweep` 只能找已知哈希，未知样本得靠 `diff` 看行为。
- 签名有效不代表作者可信，只代表文件被这个主体签过。
- 真要在陌生环境跑未签名程序，先开虚拟机或 Windows 沙盒。

## 结构

```
index.js              工具注册、报告排版、Node 侧哈希与签名
cordis.patch.yml      insert install-guard → dsh-install-guard
GUIDE.md              完整检查清单（随插件分发）
scripts/inspect.ps1   Windows 侧文件体检的原始脚本
scripts/snapshot.ps1  自启与网络基线
scripts/diff-snapshot.ps1  两份基线的差异
scripts/sweep-hash.ps1     按哈希全盘扫
locale/{zh,en}.json   Plugins 页面标题与简介
icon.svg              盾牌 + 对勾 + 一片鱼鳍
```

## 安装

profile 里以 `link:` 依赖挂着：

```
plugin_manager action=install_bundle target=D:\dafeiyu-config-pack\plugins\dsh-install-guard
```

改完 `index.js` 不会热重载，要禁用再启用：

```
plugin_manager action=set_bundle target=dsh-install-guard enabled=false
plugin_manager action=set_bundle target=dsh-install-guard enabled=true
```

## 还想上市场

目录来自 `awesome-dsh-plugin`（站点 `https://awesome-dsh-plugin.com/plugins.json`），
收录方式是往那个仓库提一条 PR。要上架还差：npm 账号发布包、一个公开 GitHub 仓库、双语文案与截图。
