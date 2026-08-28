# Aurora Agent Frontend

Aurora 的 Nuxt 4、Vue 3、TypeScript、Naive UI、Pinia 与 Tauri 2 桌面前端。

## 前后端位置

默认目录结构：

```text
GitHub/
├─ AuroraApp/   # Python 后端
└─ frontend/    # Vue/Tauri 前端
```

如果后端不在同级目录，设置绝对路径：

```bash
export AURORA_ROOT=/absolute/path/to/AuroraApp
```

## 浏览器开发

先在后端根目录配置模型：

```bash
cd ../AuroraApp
cp .env.example .env
# 填写 AGENT_API_KEY、AGENT_BASE_URL、AGENT_MODEL
uv sync
```

再启动前端：

```bash
cd ../frontend
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:3000`。Nuxt 会通过 `uv` 自动启动 Python WebSocket 运行时；如需连接其他运行时，可设置 `VITE_RUNTIME_WS`。

## Tauri 桌面开发

准备 Python、Node.js 20+、pnpm 11、Rust stable 与 Tauri 2 系统依赖后运行：

```bash
cd ../AuroraApp
uv sync

cd ../frontend
pnpm install
pnpm tauri dev
```

Tauri 会通过 stdio 自动启动同级 Aurora Python 后端，因此不需要另开后端终端。

## 检查与构建

```bash
pnpm typecheck
pnpm test
pnpm generate

cd src-tauri
cargo test --locked
cargo check --locked
```

发布桌面应用前：

```bash
cd frontend
bash build-sidecar.sh
pnpm tauri build
```

当前后端会话存于内存，重启运行时后需要新建会话。工作区列表仅保存在浏览器本地；模型配置由 Python 后端 `.env` 管理。
