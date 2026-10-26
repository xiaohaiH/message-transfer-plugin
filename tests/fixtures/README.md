# 测试专用 TLS 证书

`localhost-cert.pem` / `localhost-key.pem` 是为本项目自动化测试生成的公开、自签名 localhost 证书对, 不是凭据, 也不得用于真实服务. 测试客户端只在这些本地测试中使用 `rejectUnauthorized: false`; 实现没有关闭 TLS 证书校验

重新生成(Git Bash 下设置 `MSYS_NO_PATHCONV=1`, 避免 `/CN` 被转为文件路径):

```sh
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout tests/fixtures/localhost-key.pem -out tests/fixtures/localhost-cert.pem -days 3650 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```

该目录不会包含在发布包中
