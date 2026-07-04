# 云服务器部署说明

这份部署包是纯 Node.js 服务，不需要数据库，也不需要安装前端依赖。

## 服务器要求

- Linux 服务器，建议 Ubuntu 20.04+ 或 CentOS 7+
- Node.js 18.17 或更高版本，建议 Node.js 20+
- 如果启用商业授权，服务器需要能访问你的授权中心，例如 `https://license-center.example.com`
- 服务器能访问 Yahoo Finance、Gold API、Frankfurter 等行情源

## 上传和启动

把 zip 包上传到服务器后执行：

```bash
unzip gold-trend-desk-deploy-*.zip -d gold-trend-desk
cd gold-trend-desk
chmod +x start.sh
./start.sh
```

默认启动地址：

```text
http://<your-server-ip>:4173
```

如果要换端口：

```bash
PORT=8202 ./start.sh
```

## 授权配置

公开版默认不强制授权：

```bash
LICENSE_REQUIRED=false
PRODUCT_ID=gold-trend-desk
APP_VERSION=1.0.1
UPDATE_APPLY_ENABLED=false
```

正式商业部署时再开启授权：

```bash
LICENSE_SERVER_URL=https://license-center.example.com
PRODUCT_ID=gold-trend-desk
LICENSE_REQUIRED=true
APP_VERSION=1.0.1
UPDATE_APPLY_ENABLED=false
```

第一次在云服务器打开网站时，授权会绑定云服务器实例。部署包不会携带本机 `.license-data`，服务器会自动生成自己的授权状态目录。

临时测试时可以关闭授权：

```bash
LICENSE_REQUIRED=false ./start.sh
```

正式使用建议保持 `LICENSE_REQUIRED=true`。

## 云端更新配置

设置页已经加入 `云端更新` 面板。授权有效后，网站会通过授权中心检查新版本、读取公告、下载更新包，并在服务器端校验 SHA256 和发布签名。

默认配置：

```bash
APP_VERSION=1.0.1
UPDATE_DOWNLOAD_MAX_BYTES=536870912
UPDATE_APPLY_ENABLED=false
```

当前版本默认不自动覆盖服务器文件，`UPDATE_APPLY_ENABLED=false` 时只允许下载并验签。正式升级建议先在授权中心发布 `server-archive` 包，再在服务器备份当前目录后手动替换文件并重启服务。

## systemd 常驻运行示例

假设代码放在 `/opt/gold-trend-desk`：

```ini
[Unit]
Description=Gold Trend Desk
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gold-trend-desk
Environment=PORT=4173
Environment=LICENSE_SERVER_URL=https://license-center.example.com
Environment=PRODUCT_ID=gold-trend-desk
Environment=LICENSE_REQUIRED=true
Environment=APP_VERSION=1.0.1
Environment=UPDATE_APPLY_ENABLED=false
ExecStart=/usr/bin/node /opt/gold-trend-desk/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

保存为：

```text
/etc/systemd/system/gold-trend-desk.service
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gold-trend-desk
sudo systemctl status gold-trend-desk
```

## Nginx 反向代理示例

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 验证

启动后可以检查：

```bash
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/license/status
```

授权完成后再检查：

```bash
curl http://127.0.0.1:4173/api/gold
curl http://127.0.0.1:4173/api/professional
```

## 不应上传的内容

- `.license-data/`：本机授权租约和设备绑定信息
- `node_modules/`：当前项目没有外部依赖
- 临时截图、日志、压缩包副本
