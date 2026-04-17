#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cursor_statistics 一键安装脚本
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/hqwang/cursor_statistics/main/install.sh | bash
#   或：bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 颜色输出 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }

# ── 常量 ──────────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/hqwang/cursor_statistics.git"
VERSION="1.0.0"
INSTALL_DIR="${HOME}/cursor_statistics_${VERSION}"
NODE_MIN_MAJOR=21
NODE_MIN_MINOR=2

# ── 平台检测 ──────────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║      cursor_statistics ${VERSION} 安装程序            ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${RESET}"
echo ""
info "平台: ${OS} / ${ARCH}"
info "安装目录: ${INSTALL_DIR}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 工具函数
# ─────────────────────────────────────────────────────────────────────────────

command_exists() { command -v "$1" &>/dev/null; }

# 比较版本号：$1 >= $2 返回 0，否则返回 1
version_ge() {
  local IFS=.
  local v1=($1) v2=($2)
  local i
  for ((i=0; i<${#v2[@]}; i++)); do
    local a="${v1[i]:-0}" b="${v2[i]:-0}"
    (( 10#$a > 10#$b )) && return 0
    (( 10#$a < 10#$b )) && return 1
  done
  return 0
}

# 尝试用包管理器安装一个软件包（macOS: brew；Linux: apt/dnf/yum/pacman）
try_install() {
  local pkg="$1"
  info "尝试自动安装 ${pkg}…"
  if [[ "$OS" == "Darwin" ]]; then
    if command_exists brew; then
      brew install "$pkg" && return 0
    else
      warn "未找到 Homebrew，无法自动安装 ${pkg}"
    fi
  elif [[ "$OS" == "Linux" ]]; then
    if command_exists apt-get; then
      sudo apt-get update -qq && sudo apt-get install -y "$pkg" && return 0
    elif command_exists dnf; then
      sudo dnf install -y "$pkg" && return 0
    elif command_exists yum; then
      sudo yum install -y "$pkg" && return 0
    elif command_exists pacman; then
      sudo pacman -Sy --noconfirm "$pkg" && return 0
    fi
  fi
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 阶段 1：校验并安装依赖
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}── 阶段 1/4：检查环境依赖 ──${RESET}"

MISSING_MANUAL=()   # 需要用户手动安装的

# ── 1.1 检查 git ──────────────────────────────────────────────────────────────
if ! command_exists git; then
  warn "未找到 git，尝试自动安装…"
  if ! try_install git; then
    MISSING_MANUAL+=("git  (https://git-scm.com/downloads)")
  fi
fi
if command_exists git; then
  success "git $(git --version | awk '{print $3}')"
fi

# ── 1.2 检查 Node.js ──────────────────────────────────────────────────────────
NODE_OK=false
if command_exists node; then
  NODE_VER="$(node -e 'process.stdout.write(process.version.slice(1))')"
  REQUIRED_VER="${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}.0"
  if version_ge "$NODE_VER" "$REQUIRED_VER"; then
    success "Node.js v${NODE_VER}"
    NODE_OK=true
  else
    warn "Node.js v${NODE_VER} 低于最低要求 v${REQUIRED_VER}"
  fi
else
  warn "未找到 Node.js"
fi

if [[ "$NODE_OK" == false ]]; then
  info "尝试通过 nvm 安装 Node.js ${NODE_MIN_MAJOR}…"
  # 优先尝试 nvm（已安装的情况）
  NVM_DIR_CANDIDATE="${HOME}/.nvm"
  if [[ -s "${NVM_DIR_CANDIDATE}/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    source "${NVM_DIR_CANDIDATE}/nvm.sh"
    if nvm install "${NODE_MIN_MAJOR}" && nvm use "${NODE_MIN_MAJOR}" && nvm alias default "${NODE_MIN_MAJOR}"; then
      NODE_OK=true
      success "Node.js 已通过 nvm 安装"
    fi
  fi

  # macOS: 尝试 brew
  if [[ "$NODE_OK" == false && "$OS" == "Darwin" ]] && command_exists brew; then
    if brew install node; then
      # brew 可能装了更高版本，再次验证
      NODE_VER="$(node -e 'process.stdout.write(process.version.slice(1))')"
      if version_ge "$NODE_VER" "${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}.0"; then
        NODE_OK=true
        success "Node.js 已通过 Homebrew 安装: v${NODE_VER}"
      else
        warn "Homebrew 安装的 Node.js v${NODE_VER} 版本仍不满足要求"
      fi
    fi
  fi

  # Linux: 尝试 NodeSource 脚本
  if [[ "$NODE_OK" == false && "$OS" == "Linux" ]]; then
    if command_exists curl; then
      info "通过 NodeSource 安装 Node.js ${NODE_MIN_MAJOR}.x…"
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | sudo -E bash - \
        && sudo apt-get install -y nodejs \
        && NODE_OK=true \
        && success "Node.js 已通过 NodeSource 安装"
    fi
  fi

  if [[ "$NODE_OK" == false ]]; then
    MISSING_MANUAL+=("Node.js >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}  (推荐使用 nvm: https://github.com/nvm-sh/nvm)")
  fi
fi

# ── 1.3 检查 npm ──────────────────────────────────────────────────────────────
if command_exists npm; then
  success "npm $(npm --version)"
else
  warn "未找到 npm（通常随 Node.js 一起安装）"
  MISSING_MANUAL+=("npm  (随 Node.js 一起安装: https://nodejs.org)")
fi

# ── 1.4 若有依赖无法自动安装，提示用户后退出 ─────────────────────────────────
if [[ ${#MISSING_MANUAL[@]} -gt 0 ]]; then
  echo ""
  error "以下依赖未能自动安装，请手动安装后重试："
  for item in "${MISSING_MANUAL[@]}"; do
    echo -e "  ${RED}✗${RESET}  ${item}"
  done
  echo ""
  die "依赖检查未通过，安装终止。"
fi

echo ""
success "所有依赖检查通过"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 阶段 2：下载项目
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}── 阶段 2/4：下载项目 ──${RESET}"

if [[ -d "${INSTALL_DIR}" ]]; then
  warn "目录 ${INSTALL_DIR} 已存在"
  read -r -p "      是否覆盖安装？[y/N] " OVERWRITE
  if [[ "${OVERWRITE,,}" == "y" ]]; then
    info "删除旧目录…"
    rm -rf "${INSTALL_DIR}"
  else
    info "保留现有目录，跳过下载"
    SKIP_CLONE=true
  fi
fi

if [[ "${SKIP_CLONE:-false}" != "true" ]]; then
  info "克隆仓库 → ${INSTALL_DIR}"
  git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}" \
    || die "克隆仓库失败，请检查网络或仓库地址: ${REPO_URL}"
  success "仓库已克隆"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 阶段 3：安装 Node 依赖 & Playwright 浏览器
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}── 阶段 3/4：安装 Node 依赖 ──${RESET}"

cd "${INSTALL_DIR}"

info "npm install…"
npm install --prefer-offline
success "npm 依赖已安装"

info "安装 Playwright Chromium 浏览器…"
npx playwright install chromium
success "Playwright Chromium 已安装"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 阶段 4：注册 alias
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}── 阶段 4/4：配置 Shell alias ──${RESET}"

ALIAS_CMD="alias cursor_stats='node ${INSTALL_DIR}/cursor_stats.mjs'"
ALIAS_MARKER="# cursor_statistics alias"

# 选择 shell 配置文件
if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$(basename "${SHELL:-}")" == "zsh" ]]; then
  SHELL_RC="${HOME}/.zshrc"
elif [[ -n "${BASH_VERSION:-}" ]] || [[ "$(basename "${SHELL:-}")" == "bash" ]]; then
  SHELL_RC="${HOME}/.bashrc"
else
  # 默认回退
  SHELL_RC="${HOME}/.bashrc"
fi

info "目标配置文件: ${SHELL_RC}"

# 如果已有旧 alias，先清除
if grep -q "${ALIAS_MARKER}" "${SHELL_RC}" 2>/dev/null; then
  warn "检测到旧版 alias，正在更新…"
  # 删除旧的 marker + alias 两行
  if [[ "$OS" == "Darwin" ]]; then
    sed -i '' "/${ALIAS_MARKER}/d" "${SHELL_RC}"
    sed -i '' "/alias cursor_stats=/d" "${SHELL_RC}"
  else
    sed -i "/${ALIAS_MARKER}/d" "${SHELL_RC}"
    sed -i "/alias cursor_stats=/d" "${SHELL_RC}"
  fi
fi

# 追加 alias
{
  echo ""
  echo "${ALIAS_MARKER}"
  echo "${ALIAS_CMD}"
} >> "${SHELL_RC}"

success "alias 已写入 ${SHELL_RC}"

# ─────────────────────────────────────────────────────────────────────────────
# 完成
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║           安装完成！                             ║${RESET}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  安装路径: ${CYAN}${INSTALL_DIR}${RESET}"
echo -e "  使用方式:"
echo -e "    ${BOLD}1. 重新加载 Shell:${RESET}"
echo -e "       ${CYAN}source ${SHELL_RC}${RESET}"
echo -e "    ${BOLD}2. 运行统计脚本:${RESET}"
echo -e "       ${CYAN}cursor_stats${RESET}"
echo ""
echo -e "  首次运行将打开浏览器引导登录，Session 保存后后续免登录。"
echo ""

# 尝试在当前 shell 中立即生效（仅在非 pipe 模式下有效）
if [[ -t 0 ]]; then
  # shellcheck disable=SC1090
  source "${SHELL_RC}" 2>/dev/null || true
  info "已尝试在当前 shell 中加载 alias（如未生效请手动执行 source ${SHELL_RC}）"
fi
