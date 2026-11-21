# nulls headless client

[RU](README.md) · [EN](README.en.md) · [TR](README.tr.md) · **ZH**

[![ci](https://github.com/Patrick-9936/nulls-headless-client/actions/workflows/ci.yml/badge.svg)](https://github.com/Patrick-9936/nulls-headless-client/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Patrick-9936/nulls-headless-client)](https://github.com/Patrick-9936/nulls-headless-client/releases)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Nulls Brawl 69.252** 协议的无头 Node.js 客户端：账号、俱乐部、房间、好友、观战，
以及同时运行多个会话。不用安装游戏，不需要 root，不修改 APK——只有网络和协议。

非官方项目，与 Supercell 或 Nulls 无关。代码采用 MIT 许可（[`LICENSE`](LICENSE)），
关于游戏及其资源的说明见 [`NOTICE.md`](NOTICE.md)。
需要 Node.js 20+，可在 Windows、Linux、macOS 和 Android（Termux）上运行。

## 功能

| 模块 | 能力 |
|---|---|
| 账号 | 创建游客、令牌登录、选择区域、更换设备、防止两个会话共用同一文件 |
| 俱乐部 | 创建、加入、聊天、动态、申请、角色、踢人、邀请、设置、排行榜、推荐 |
| 房间 | 创建房间或用代码加入、好友/俱乐部邀请、回复、模式与地图、准备状态 |
| 好友 | 按标签添加、接受、拒绝、删除、列表与在线状态 |
| 对战 | 匹配、取消、加载对战、UDP 帧、Brawl TV 与玩家观战 |
| 集群 | 运行数十个机器人、实时命令、暂停与恢复、逐机器人状态 |
| 界面 | 交互式菜单、CLI、四种语言（ru / en / tr / zh）、供脚本使用的 JSON 输出 |
| 绑定 | Nulls Connect：邮箱 PIN、bearer 令牌、绑定游戏账号 |

哪些已在真实服务器上验证：见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md) 与
`node Program.js features`。

## 快速开始

### 单文件

从[最新发行版](https://github.com/Patrick-9936/nulls-headless-client/releases/latest)下载
`Nulls.js`：

```sh
node Nulls.js
```

方向键、回车、esc、ctrl+c。首次运行会在脚本旁生成 `.nulls-single-<版本>` 目录——
不要删除，已保存的登录信息在里面。详见 [`docs/TUI.md`](docs/TUI.md)。

### 从 git

```sh
git clone https://github.com/Patrick-9936/nulls-headless-client.git
cd nulls-headless-client
npm ci --ignore-scripts
node TUI.js
```

### Termux

请解压到**家目录**，不要放在 Android 共享存储——那里没有写入状态文件的权限：

```sh
cd ~ && unzip nulls-headless-client.zip && cd nulls-headless-client
node TUI.js
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/PLATFORMS.md`](docs/PLATFORMS.md) | 各平台可用性、Termux 限制 |
| [`docs/COMMANDS.md`](docs/COMMANDS.md) | 完整 CLI 参考 |
| [`docs/FLEET.md`](docs/FLEET.md) | 机器人集群 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 客户端结构 |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | 已在真实服务器验证的内容 |

完整细节见俄语 README：[`README.md`](README.md)。

## 许可

源代码采用 MIT。游戏资源、APK 内容与数据包转储不在许可范围内——
见 [`NOTICE.md`](NOTICE.md)。