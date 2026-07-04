# Gold Trend Desk

Gold Trend Desk 是一个本地优先的黄金走势分析工作台。它把黄金价格、美元指数、美国国债收益率、ETF、波动率、新闻情绪和技术面指标汇总到一个网页里，用于辅助观察未来 1 天、1 周、1 月、3 个月、半年和 1 年的黄金走势倾向。

> 本项目只用于行情研究、产品原型和学习参考，不构成投资建议。

## 功能概览

- 首页给出 6 个周期的涨跌倾向、置信度和主要驱动因素
- 简易模式面向普通用户，突出“未来会偏涨还是偏跌”
- 专业模式展示美元、利率、ETF、金矿股、VIX、专业新闻和研究清单
- 设置页支持涨跌颜色、简易/专业模式、软件授权和云端更新面板
- 风险页集中展示免责声明、模型风险、数据延迟和合规提示
- 复盘页支持记录预测、统计命中率、配置事件日历和价格提醒
- 后端提供安全响应头、静态文件白名单、授权校验和更新包验签逻辑

## 预测模型思路

项目采用可解释的综合评分方式，而不是承诺确定性预测。

当前模型主要参考四类公开分析框架：

- 经济与通胀：人民币金价、汇率、宏观校准项
- 风险不确定性：VIX、避险情绪、重大事件和新闻情绪
- 机会成本：美元指数、美国 10 年期收益率
- 动量趋势：均线、历史波动、ETF 和金矿股联动

模型输出包括方向、分数、置信度和关键驱动项。分数越高代表偏涨倾向越强，越低代表偏跌倾向越强。

## 快速开始

要求：

- Node.js 18.17 或更高版本
- 可访问公开行情源的网络环境

启动：

```bash
npm start
```

或：

```powershell
.\start.ps1
```

默认访问：

```text
http://localhost:4173
```

默认情况下，项目以本地演示模式运行：

```env
LICENSE_REQUIRED=false
```

## 环境变量

复制 `.env.example` 后按需配置：

```env
PORT=4173
PRODUCT_ID=gold-trend-desk
APP_VERSION=1.0.1

LICENSE_REQUIRED=false
LICENSE_SERVER_URL=https://license-center.example.com
LICENSE_PUBLIC_KEY_PATH=/absolute/path/to/license-public.pem

UPDATE_APPLY_ENABLED=false
UPDATE_DOWNLOAD_MAX_BYTES=536870912
```

如果你没有自己的授权中心，保持 `LICENSE_REQUIRED=false` 即可。

如果你接入了兼容的授权中心，需要提供：

- 授权中心地址
- 产品 ID
- 授权中心签名公钥
- 对应产品许可证

## 行情和数据源

项目会尝试读取公开行情源：

- 黄金期货：Yahoo Finance `GC=F`
- 美元人民币：Yahoo Finance `USDCNY=X`
- 美元指数：Yahoo Finance `DX-Y.NYB`
- 美国 10 年期收益率：Yahoo Finance `^TNX`
- 黄金 ETF：Yahoo Finance `GLD`
- 金矿股 ETF：Yahoo Finance `GDX`
- 波动率：Yahoo Finance `^VIX`
- 专业新闻：Yahoo Finance RSS

部分数据源可能会因地区、网络、接口策略而不可用。页面会用“暂无”或数据源说明展示失败状态。

## 授权中心和云端更新

本项目保留了商业化授权中心的接入点，但公开仓库不包含任何私钥、数据库、真实服务器地址、授权码或客户数据。

授权相关边界：

- 客户端项目只应包含授权中心公钥
- 私钥、pepper、数据库和管理员 Cookie 不应进入本仓库
- `.license-data/` 是本地运行态目录，已被 `.gitignore` 排除
- 云端更新包必须经过 SHA256 和签名校验
- 默认 `UPDATE_APPLY_ENABLED=false`，只允许下载并验签，不自动覆盖服务器文件

## 项目结构

```text
.
├── app.js              # 前端交互、预测模型、设置页和复盘逻辑
├── index.html          # 单页应用结构
├── styles.css          # 视觉样式
├── server.js           # Node.js 后端、行情代理、授权和更新接口
├── start.ps1           # Windows 启动脚本
├── start.sh            # Linux/macOS 启动脚本
├── .env.example        # 环境变量示例
├── DEPLOY.md           # 部署说明
├── AUTHORIZATION.md    # 授权中心接入说明
└── GITHUB_PUBLISH_CHECKLIST.md
```

## 安全说明

公开前请确认不要提交：

- `.license-data/`
- `.env`
- `*.pem` 私钥或真实生产公钥
- 数据库、日志、备份、压缩包
- 服务器 IP、密码、Cookie、Token、真实许可证
- `node_modules/`、构建产物或视频素材输出

更完整的检查清单见 [GITHUB_PUBLISH_CHECKLIST.md](./GITHUB_PUBLISH_CHECKLIST.md)。

## 免责声明

本项目输出的是基于公开数据和规则模型的研究结果，不保证准确性、完整性、实时性或盈利结果。黄金、基金、股票、期货和实物贵金属价格均可能大幅波动。任何投资、交易、资产配置或实物买卖决策都应由使用者独立判断并自行承担风险。
