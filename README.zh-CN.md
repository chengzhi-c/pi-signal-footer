# pi-signal-footer

[English](README.md) | 简体中文

为 [Pi Coding Agent](https://github.com/earendil-works/pi-mono) 提供的状态栏，替代内置 footer。

```text
C:/Users/dev/agent-demo · fix-context-bar  │  opencode-go › ◎ deepseek-v4-flash-0731 │ ✦ max │ ⎇ main   ⎔ 12% [━━─────────────────] 36k/300k
↓ 213 ↑ 32k │ ↻ 5.1M (97%) ✎ 137k │ $0.087 │ ◷ 2h25m · 1轮 · 45 tok/s                                             ⇄ MCP 1/1 · LSP typescript
```

取自 140 列且存在扩展状态的终端；带状态的那一行会补齐到终端全宽，所以徽标贴在最右侧。

第一行显示项目路径、会话名、provider 和模型、思考等级、Git 分支。模型图标按模型家族匹配，主目录下的路径缩写为 `~`。上下文占用条最多占 20 列，显示百分比与已用/窗口 token：占用 ≥50% 变警告色，≥75% 变错误色，未知时显示 `?`。

第二行显示输入/输出 token、缓存读与命中率、缓存写、累计成本、首末条会话记录的时间跨度与轮次（按用户消息计），以及最近一次响应的流式速率。其他扩展写入的 MCP、LSP 状态按同一套样式渲染，识别不了的文案原样显示；而识别成功但内容为 `MCP 0/0`、`LSP Inactive` 时不显示徽标。

终端变窄时两行先拆成三行（第三行要等有扩展写入状态时才出现）、再拆成大致每行一个字段。空间不足时先让位的是上下文占用条，然后是 token 数值，再然后是项目路径；模型名是最后才被缩短的身份字段，约 40 列以下才会截断它。颜色全部取自当前 Pi 主题，图标是实测宽度为 1 的纯文本字形。

## 安装

### npm

```sh
pi install npm:pi-signal-footer
```

不带版本号，随 `pi update --extensions` 自动更新。固定版本用 `pi install npm:pi-signal-footer@<版本号>`。

### Git

```sh
pi install git:github.com/chengzhi-c/pi-signal-footer@v<版本号>
```

固定在 tag 上；升级时用新 tag 重新执行这条命令。

### 本地路径

```sh
pi install ./pi-signal-footer
```

加载磁盘上的目录，适合开发调试。

基于 Pi Coding Agent 0.84.4 与 Node.js 22.19.0（`engines` 声明的下限）开发并测试。包通过 peer dependency（`>=0.84.4`）声明 Pi 随宿主提供的模块。`pi install` 不会执行 npm peer，旧宿主仍会加载 TypeScript 源码；本扩展在 `session_start` 警告一次，随后保留 Pi 原生状态栏，不调用 custom-footer API。

## 配置

设置写在 Pi 代理目录（`getAgentDir()`，通常是 `~/.pi/agent/`）下的 `pi-signal-footer.json`。文件缺失使用下列默认值；JSON 无效或文件不可读时同样回退默认值并只告警一次。合法的部分对象可以省略字段，未知键忽略；已知键类型错误时该字段使用默认值，告警会列出具体字段（允许的语言是 `auto`、`zh` 和 `en`）。

```json
{
  "enabled": true,
  "locale": "auto",
  "showProject": true,
  "showSessionName": true,
  "showDuration": true,
  "showTurns": true,
  "showSpeed": true,
  "showBranch": true,
  "showCacheRatio": true
}
```

`/signal-footer` 的单项开关、`/signal-footer locale` 与 `/signal-footer off|on` 会写这个文件。不再靠改包内 `index.ts`；若你以前改过 `CONFIG`，把开关拷到这里。

## 识别的上游状态文案

MCP 与 LSP 徽标解析自其他扩展写入的状态字符串，本质是一份文本契约。无法识别的文案原样放行而非丢弃，这是有意的降级方式：上游改了措辞，你失去的是徽标样式，不是信息本身。下表每一行都是解析器确实接受的完整字面量。

| 来源 | 文案 | 解析函数 |
|------|------|----------|
| pi-mcp-adapter | `MCP 1/2` | `parseMcpStatus` |
| pi-mcp-adapter | `🔌 MCP: 3 servers enabled (2 connected) (1 disabled)` | `parseMcpStatus` |
| pi-lens | `LSP Active: typescript, python` | `parseLspStatus` |
| pi-lens | `LSP Failed: clangd` | `parseLspStatus` |
| pi-lens | `LSP Inactive` | `parseLspStatus` |

有两种能被识别、但刻意不渲染徽标的输入：`MCP 0/0`（没有启用的服务器）与 `LSP Inactive`（没有活动服务器）。

上述扩展不是本包的依赖，因此表中文案只是写这几个解析函数时上游实际输出的样子，并未锚定到某个可核对的版本号。某个状态不再渲染成徽标时，说明上游措辞变了——带上确切文本提 issue 即可补上。LSP 的新状态按需增量解析，不预先穷举。

## 命令

```text
/signal-footer legend              在编辑器上方显示指标图例
/signal-footer hide                隐藏图例（本会话）
/signal-footer help                显示全部命令
/signal-footer off                 切回原生状态栏并记住该选择；重复执行无变化
/signal-footer on                  启用本状态栏并记住该选择
/signal-footer path [on|off]       显示/隐藏项目路径（省略 on|off 即切换）
/signal-footer session [on|off]    显示/隐藏会话名
/signal-footer time [on|off]       显示/隐藏会话时长
/signal-footer turns [on|off]      显示/隐藏轮次
/signal-footer speed [on|off]      显示/隐藏响应速率
/signal-footer branch [on|off]     显示/隐藏 Git 分支
/signal-footer cache [on|off]      显示/隐藏缓存命中率
/signal-footer status              显示设置文件路径、总开关、各项开关、有效语言、加载错误和无效字段
/signal-footer locale auto|zh|en   持久化界面语言（auto 跟随宿主 locale）
```

`off` 与 `on` 跨会话持久且幂等：`off` 之后由 Pi 原生状态栏接管，`/signal-footer on` 可切回。

每项的名字本身就是指令：`/signal-footer path off` 隐藏项目路径，省略 `on|off` 则在两个状态间切换。各项选择与 `off`/`on` 一样跨会话持久。

## 开发

```sh
npm test
npm run typecheck
npm run check
npm run pack:check
npm run bench:footer
```

`npm run check` 跑测试套件和 TypeScript 检查，`npm run pack:check` 预览将随包发布的文件。TypeScript 检查跳过 Pi SDK 依赖树内的声明，扩展源码本身按严格模式检查。
`npm run bench:footer` 是本地可选基准，用于观察渲染耗时和输出宽度，不作为 CI 门禁。

## 许可证

[MIT](LICENSE)
