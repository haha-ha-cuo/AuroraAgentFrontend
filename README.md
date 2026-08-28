# Aurora Agent Frontend

Aurora Agent 的独立桌面前端，使用 Nuxt 4、Vue 3、TypeScript、Naive UI 和 Pinia 开发，并通过 Tauri 2 打包为桌面应用。

## 目录结构

```text
frontend/
├─ app/                         # 页面、组件、状态和前端运行时客户端
├─ modules/dev-backend.ts       # 浏览器开发时启动 Python WebSocket 后端
├─ public/                      # Logo 等静态资源
├─ src-tauri/                   # Tauri Rust 壳、系统钥匙串和 sidecar broker
├─ tests/                       # Vitest 测试
└─ build-sidecar.sh             # 生成随桌面应用分发的 Python runtime
```

## 后端位置

开发模式默认使用与本目录同级的 `demo` 后端：

```text
GitHub/
├─ demo/
└─ frontend/
```

若后端在其他位置，启动前设置绝对路径：

```bash
export DEMO_AGENT_ROOT=/absolute/path/to/demo
```

## 安装与开发

环境要求：Node.js 20+、pnpm 11、Rust stable、Tauri 2 系统依赖，以及由 uv 管理的 Python 后端环境。

```bash
pnpm install

# 浏览器联调；会自动通过 uv 启动 demo 后端的 WebSocket 服务
pnpm dev

# Tauri 桌面开发；Rust broker 通过 stdio 启动 demo 后端
pnpm tauri dev
```

浏览器页面默认为 `http://127.0.0.1:3000`。设置 `VITE_RUNTIME_WS` 后，前端会连接指定 WebSocket 地址，并跳过自动启动本地后端。

## 检查与构建

```bash
pnpm typecheck
pnpm test
pnpm generate

cd src-tauri
cargo test --locked
cargo check --locked
```

桌面静态产物位于 `.output/public`，Tauri 配置会在打包前自动执行 `pnpm generate`。

## 打包 Python sidecar

发布桌面应用前，在前端根目录执行：

```bash
bash build-sidecar.sh
pnpm tauri build
```

脚本使用 uv 从 `demo` 构建独立 Python runtime 到 `src-tauri/resources/sidecar/`。开发时若不存在该产物，Tauri 会回退到 `uv run --no-sync python -m demo_agent --stdio`。

API Key 由 Tauri 写入系统钥匙串，不进入 SQLite、Pinia 或日志；非敏感 Provider、Base URL 和模型配置仍以 Python 后端的 SQLite 应用设置为唯一事实源。
