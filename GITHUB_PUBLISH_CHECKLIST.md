# GitHub 发布前检查清单

这个清单用于把 Gold Trend Desk 发布到公开 GitHub 仓库前做最后确认。

## 可以公开的核心文件

- `index.html`
- `styles.css`
- `app.js`
- `server.js`
- `package.json`
- `README.md`
- `DEPLOY.md`
- `AUTHORIZATION.md`
- `.env.example`
- `.gitignore`
- `start.ps1`
- `start.sh`

## 不要提交的内容

- `.license-data/`
- `.env`、`.env.local`、`.env.production`
- `license-public.pem` 和任何真实 `.pem` 文件
- 授权中心私钥、pepper、SQLite 数据库、管理员 Cookie
- 历史部署包：`*.zip`、`*.tar.gz`、`*.tgz`
- 服务器备份、日志、运行时数据目录
- 真实服务器 IP、用户名、密码、许可证密钥、客户信息
- `node_modules/`
- `douyin-gold-video/` 这类本项目以外的营销素材和视频产物

## 上传前命令

```bash
node --check server.js
node --check app.js
```

敏感信息扫描：

```bash
rg -n -uu "PRIVATE KEY|BEGIN RSA PRIVATE|license-pepper|licenses.sqlite|license_admin_session|password|token|cookie|sk-(proj|live|test)-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{20,}|\\.license-data|\\.env|root@" .
```

也建议额外扫描你自己知道的服务器 IP、域名、账号名和密码片段，但不要把这些真实值写进公开仓库文档。

如果使用 Git 上传，先确认即将提交的文件：

```bash
git status --short
git check-ignore -v .license-data/ *.zip *.tar.gz douyin-gold-video/ license-public.pem
```

## 公开仓库建议

- 默认保持 `LICENSE_REQUIRED=false`
- 授权中心地址只写在 `.env` 或部署平台环境变量中
- 生产部署时再提供 `LICENSE_SERVER_URL`、`LICENSE_PUBLIC_KEY_PATH`、`PRODUCT_ID`
- 如果你想开源给别人复用，后续需要单独选择并添加开源许可证
- 如果只是公开展示代码但不授权复用，可以保持 `package.json` 的 `UNLICENSED`

## 最后确认

发布前确认：

- README 中没有真实服务器地址
- 文档中没有 root 密码、管理员密码或授权码
- 压缩包和本机运行数据没有进入提交列表
- 应用可以在未接入授权中心时本地启动
- 商业授权相关内容只作为可选能力出现
