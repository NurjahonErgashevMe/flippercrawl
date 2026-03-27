const { spawnSync } = require("child_process")
const path = require("path")

if (process.env.SKIP_NATIVE_BUILD === "1" || process.env.SKIP_NATIVE_BUILD === "true") {
  console.warn(
    "[@mendable/firecrawl-rs] SKIP_NATIVE_BUILD: локальная сборка пропущена. " +
      "При запуске API через Docker native собирается в образе (`docker compose build`). " +
      "Локальный `node`/Jest без собранного .node может падать на импорте.",
  )
  process.exit(0)
}

const cargo = spawnSync("cargo", ["--version"], {
  shell: true,
  encoding: "utf8",
})
if (cargo.status !== 0) {
  console.error(
    "[@mendable/firecrawl-rs] Не найден Rust (cargo) в PATH.\n" +
      "  Только Docker: Rust на хосте не нужен — в apps/api/Dockerfile уже ставится Rust и собирается native. " +
      "Поднимайте стек: `docker compose build` / `docker compose up`. Локальный `pnpm install` без сборки native: " +
      "SKIP_NATIVE_BUILD=1 pnpm install  (PowerShell: $env:SKIP_NATIVE_BUILD='1'; pnpm install)\n" +
      "  Локальный запуск node без Docker: https://rustup.rs/  (Windows: ещё VS Build Tools, C++)",
  )
  process.exit(1)
}

const build = spawnSync("pnpm", ["run", "build"], {
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
  shell: true,
})
process.exit(build.status ?? 1)
