#!/usr/bin/env node
/**
 * cursor_stats.mjs — Cursor 周统计采集器
 *
 * 用法：
 *   npm install
 *   node cursor_stats.mjs
 *
 * 首次运行会打开浏览器引导登录，session 保存后后续免登录。
 */

import { chromium }  from "playwright";
import { parse as csvParse } from "csv-parse/sync";
import {
  existsSync, mkdirSync, writeFileSync,
  readFileSync, copyFileSync, rmSync,
} from "fs";
import path from "path";
import os   from "os";

// ─────────────────────────── 路径 ───────────────────────────────────────────
const ROOT          = import.meta.dirname;
const DESKTOP       = path.join(os.homedir(), "Desktop");
const SESSION_FILE  = path.join(ROOT, ".cursor_session.json");
let SHOTS_DIR; // 在 main() 中按日期范围动态设置
// DATA_FILE 在 main() 中按日期动态生成

// ─────────────────────────── 日志 ───────────────────────────────────────────
function log(tag, ...msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] ${tag}`, ...msg);
}
function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ─────────────────────────── 日期工具 ───────────────────────────────────────
const DAY = ["日","一","二","三","四","五","六"];

/** 返回 [上周四, min(本周三, 今天)] */
function weekRange() {
  const now = new Date();
  // new Date(y,m,d) 始终用本地时区，避免 UTC 偏差导致日期错误
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // getDay(): 0=周日 1=周一 … 6=周六
  const dow     = today.getDay();
  const toMon   = dow === 0 ? -6 : 1 - dow;   // 距本周一的偏移
  const monday  = new Date(today);
  monday.setDate(today.getDate() + toMon);
  const lastThu = new Date(monday); lastThu.setDate(monday.getDate() - 4);
  const thisWed = new Date(monday); thisWed.setDate(monday.getDate() + 2);
  // 若本周三晚于今天，取今天
  const end = thisWed > today ? today : thisWed;
  return [lastThu, end];
}

function fmt(d) {
  // 用本地年月日，避免 toISOString() 转 UTC 导致 CST 日期偏移 -1 天
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function* eachDay(start, end) {
  const d = new Date(start);
  while (d <= end) { yield new Date(d); d.setDate(d.getDate() + 1); }
}

/** 判断文本是否包含日期 d 的常见格式 */
function hasDate(text, d) {
  const m = d.getMonth() + 1, dd = d.getDate(), y = d.getFullYear();
  return [
    `${m}/${dd}`,
    `${String(m).padStart(2,"0")}/${String(dd).padStart(2,"0")}`,
    `${m}-${dd}`,
    `${String(m).padStart(2,"0")}-${String(dd).padStart(2,"0")}`,
    `${y}-${String(m).padStart(2,"0")}-${String(dd).padStart(2,"0")}`,
    `${m}月${dd}日`,
    `${m}月${dd}`,
  ].some(p => text.includes(p));
}

// ─────────────────────────── 浏览器启动 ─────────────────────────────────────
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

async function launchBrowser() {
  const execPath = CHROME_PATHS.find(p => existsSync(p));
  const opts = {
    headless: false,
    slowMo: 200,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  };
  if (execPath) {
    opts.executablePath = execPath;
    log("🌐", `使用系统 Chrome: ${execPath}`);
  } else {
    opts.channel = "chrome";
    log("🌐", "channel=chrome（未找到本地路径）");
  }
  return chromium.launch(opts);
}

async function newContext(browser) {
  const opts = {
    viewport         : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (existsSync(SESSION_FILE)) {
    opts.storageState = SESSION_FILE;
    log("💾", `加载已有 session: ${SESSION_FILE}`);
  } else {
    log("💾", "未找到 session，将引导登录");
  }
  return browser.newContext(opts);
}

// ─────────────────────────── 登录 ───────────────────────────────────────────
async function ensureLoggedIn(page, ctx) {
  log("🔑", "跳转 dashboard…");
  await page.goto("https://cursor.com/cn/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  log("🔑", `当前 URL: ${page.url()}`);

  if (!page.url().includes("dashboard")) {
    log("🔑", "检测到未登录，请在浏览器中完成登录（最多等待 3 分钟）…");
    try {
      await page.waitForURL("**/dashboard**", {
        timeout   : 180_000,
        waitUntil : "domcontentloaded",
      });
    } catch {
      log("❌", "登录超时");
      return false;
    }
    log("✅", "登录成功");

    // 登录后重新进入 dashboard，等待 React 渲染完成再保存 session
    // （确保 cursor.com 的 session token 完全写入后再捕获）
    log("🔄", "重新加载 dashboard…");
    await page.goto("https://cursor.com/cn/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);   // 等待 session token 落地

    // 保存 session
    const state = await ctx.storageState();
    writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
    log("💾", `session 已保存 → ${SESSION_FILE}`);
  } else {
    log("✅", "已登录");
    if (!existsSync(SESSION_FILE)) {
      const state = await ctx.storageState();
      writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
      log("💾", "session 首次保存完成");
    }
  }

  // 等待 SPA 渲染关键内容（轮询检测，不依赖固定超时）
  log("⏳", "等待 dashboard 内容渲染…");
  await page.waitForFunction(
    () => (document.body?.innerText ?? "").includes("AI Line Edits"),
    { timeout: 60_000, polling: 500 },
  ).catch(() => log("⚠️", "等待内容超时，继续尝试…"));
  log("✅", "dashboard 已就绪");
  return true;
}

// ─────────────────────────── Part 1：AI Line Edits ──────────────────────────
/**
 * 热力图结构（类 GitHub contribution graph）：
 *   模块容器
 *   ├── 标题 "AI Line Edits" + 总数
 *   └── 热力图网格（小方格，每格 = 1 天）
 *
 * 截图策略：hover 格子 → popup 出现在格子上方 →
 *   用 page.screenshot({ clip }) 截取"模块区域 + 上方留白"，确保 popup 不被裁掉。
 */
async function collectLineEdits(page, start, end) {
  section("Part 1 — AI Line Edits 截图");
  mkdirSync(SHOTS_DIR, { recursive: true });
  log("📁", `截图目录: ${SHOTS_DIR}`);

  // ── 1. 等待模块标题出现（轮询，不依赖固定超时） ─────────────────────────────
  log("🔍", "等待 'AI Line Edits' 标题…");
  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText ?? "";
        return text.includes("AI Line Edits");
      },
      { timeout: 30_000, polling: 500 },
    );
    log("✅", "找到标题");
  } catch {
    log("❌", "未找到 'AI Line Edits'，保存调试截图");
    await page.screenshot({ path: path.join(DESKTOP, "cursor_debug_dashboard.png"), fullPage: true });
    return {};
  }
  // ── 2. 模块容器：从格子往上找包含标题的祖先 ──────────────────────────────
  log("🔍", "定位模块容器…");
  const firstCell = page.locator('[data-tooltip-id="contribution-tooltip"]').first();
  if (await firstCell.count()) {
    await firstCell.evaluate((el) => {
      let node = el.parentElement;
      while (node && node !== document.body) {
        if ((node.innerText || "").includes("AI Line Edits")) {
          node.setAttribute("data-cursor-stats", "line-edits");
          return;
        }
        node = node.parentElement;
      }
      // 兜底：格子的第 8 级祖先
      let p = el;
      for (let i = 0; i < 8; i++) p = p.parentElement || p;
      p.setAttribute("data-cursor-stats", "line-edits");
    });
  } else {
    // 无格子时从标题往上找
    const heading = page.getByText("AI Line Edits", { exact: false }).first();
    await heading.evaluate((el) => {
      let node = el.parentElement;
      for (let i = 0; i < 20 && node && node !== document.body; i++) {
        if (node.querySelectorAll("div,rect,span").length > 20) {
          node.setAttribute("data-cursor-stats", "line-edits");
          return;
        }
        node = node.parentElement;
      }
      let p = el;
      for (let i = 0; i < 6; i++) p = p.parentElement || p;
      p.setAttribute("data-cursor-stats", "line-edits");
    });
  }
  const moduleLoc = page.locator('[data-cursor-stats="line-edits"]');
  log("✅", "模块容器已定位");

  // ── 3. 定位模块 boundingBox（用于截图 clip） ─────────────────────────────

  // ── 4. 找目标日期的热力图格子 ────────────────────────────────────────────
  log("🔍", "查找热力图格子（解析 data-tooltip-html）…");

  const targetDates = [...eachDay(start, end)];
  const targetKeys  = new Set(targetDates.map(fmt));
  const daily = {};     // { "YYYY-MM-DD": lines }

  // 策略 A：解析 data-tooltip-html 属性（无需 hover）
  const cellsByAttr = await findCellsByTooltipHtml(page, targetKeys);

  if (cellsByAttr.size > 0) {
    log("✅", `策略A：找到 ${cellsByAttr.size} 个目标格子`);
    await page.waitForTimeout(200);
    for (const [dateKey, { cell, lines }] of cellsByAttr) {
      if (lines === 0) {
        daily[dateKey] = 0;
        log("⏭ ", `  ${dateKey} 行数为 0，跳过截图`);
      } else {
        // lines > 0（已确认有数据）或 null（解析失败，保守处理：hover 后再提取）
        await hoverAndShot(page, cell, dateKey, moduleLoc, daily, lines);
      }
    }
  } else {
    // 策略 B：扫描模块内所有小格子，hover 后读 popup 判断日期
    log("⚠️ ", "策略A 无结果，改用策略B：扫描热力图格子");
    await scanHeatmapCells(page, moduleLoc, targetKeys, daily);
  }

  // ── 5. 写入数据文件 ─────────────────────────────────────────────────────────
  return daily;
}

/** 从 data-tooltip-html 属性解析 { dateKey, lines } */
function parseTooltipHtml(html) {
  if (!html) return null;
  // 日期格式："Sunday, April 13, 2025"
  const MONTHS = {
    January:1, February:2, March:3, April:4, May:5, June:6,
    July:7, August:8, September:9, October:10, November:11, December:12,
  };
  const dm = html.match(
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/
  );
  if (!dm) return null;
  const month = MONTHS[dm[1]];
  if (!month) return null;
  // 时区修正：Cursor 统计日期比本地早一天，+1 天还原实际日期
  const localDate = new Date(parseInt(dm[3], 10), month - 1, parseInt(dm[2], 10) + 1);
  const year  = String(localDate.getFullYear());
  const mm    = String(localDate.getMonth() + 1).padStart(2, "0");
  const dd    = String(localDate.getDate()).padStart(2, "0");
  const dateKey = `${year}-${mm}-${dd}`;

  // 行数解析
  if (/No Lines Edited/i.test(html)) return { dateKey, lines: 0 };

  // 尝试多种格式（含 "AI Line Edits"、"Lines Edited" 等变体）
  const lm = html.match(/<strong>([\d,]+)<\/strong>\s+Lines\s+Edited/);
  if (lm) return { dateKey, lines: parseInt(lm[1].replace(/,/g,""), 10) };
  return { dateKey, lines: null };   // 解析失败，交给 hover 后提取
}

/** 策略 A：解析 data-tooltip-html 属性，直接提取日期和行数（无需 hover） */
async function findCellsByTooltipHtml(page, targetKeys) {
  const result = new Map();   // dateKey → { cell, lines }

  const cells = page.locator('[data-tooltip-id="contribution-tooltip"]');
  const n = await cells.count();
  log("🔍", `  扫描 ${n} 个 contribution 格子的 data-tooltip-html…`);

  for (let i = 0; i < n; i++) {
    const cell = cells.nth(i);
    const html = await cell.getAttribute("data-tooltip-html").catch(() => null);
    const parsed = parseTooltipHtml(html);
    if (parsed && targetKeys.has(parsed.dateKey) && !result.has(parsed.dateKey)) {
      if (parsed.lines === null) {
        log("🐛", `  ${parsed.dateKey} 行数解析失败，原始 HTML: ${(html||"").slice(0,200)}`);
      }
      result.set(parsed.dateKey, { cell, lines: parsed.lines });
    }
    if (result.size === targetKeys.size) break;   // 全部找到，提前退出
  }

  return result;
}

/** 策略 B：扫描模块内所有小格子（按尺寸过滤），hover 后读 popup 判断日期 */
async function scanHeatmapCells(page, moduleLoc, targetKeys, daily) {
  const scope = (await moduleLoc.count()) ? moduleLoc : page;

  // 收集候选格子（热力图格子通常是 rect/div/td/span 小正方形）
  const candidates = scope.locator("rect, div, td, span");
  const n = Math.min(await candidates.count(), 600);
  log("🔍", `策略B：扫描候选元素 ${n} 个（尺寸过滤热力图格子）…`);

  const remaining = new Set(targetKeys);

  for (let i = 0; i < n && remaining.size > 0; i++) {
    const cell = candidates.nth(i);

    // 尺寸过滤：热力图格子通常是 5~35px 的近似正方形
    const box = await cell.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.width < 5 || box.width > 35 || box.height < 5 || box.height > 35) continue;
    if (Math.abs(box.width - box.height) > 6) continue;

    // hover
    try {
      await cell.hover({ force: true });
      await page.waitForTimeout(200);
    } catch {
      continue;
    }

    // 读 popup/tooltip 检查目标日期
    let matched = null;
    for (const sel of [
      '[role="tooltip"]',
      '[class*="tooltip"i]',
      '[class*="popover"i]',
      '[class*="popup"i]',
    ]) {
      const tip = page.locator(sel).last();
      if (!(await tip.count())) continue;
      const txt = await tip.innerText().catch(() => "");
      if (!txt) continue;
      for (const key of remaining) {
        if (hasDate(txt, new Date(key + "T00:00:00"))) { matched = key; break; }
      }
      if (matched) break;
    }

    if (!matched) continue;

    remaining.delete(matched);
    log("✅", `  匹配到格子: ${matched}`);
    await hoverAndShot(page, cell, matched, moduleLoc, daily);
  }

  if (remaining.size > 0) {
    log("⚠️ ", `  未找到 ${remaining.size} 个日期格子: ${[...remaining].join(", ")}`);
  }
}

/** 公共：hover 格子 → 等待 popup → 截图 → 读取行数 */
async function hoverAndShot(page, cell, dateKey, moduleLoc, daily, knownLines = null) {
  const d     = new Date(dateKey + "T00:00:00");
  const label = `${dateKey} 周${DAY[d.getDay()]}`;
  log("🖱 ", `hover → ${label}`);

  try {
    await cell.hover({ force: true });
    await page.waitForTimeout(300);   // 等 popup 动画完成
  } catch (e) {
    log("⚠️ ", `  hover 失败: ${e.message}`);
    return;
  }

  // 截图（每次动态获取模块位置，避免滚动后偏移）
  const shot = path.join(SHOTS_DIR, `line_edits_${dateKey.replace(/-/g,"")}.png`);
  if (moduleLoc && await moduleLoc.count()) {
    const box = await moduleLoc.boundingBox().catch(() => null);
    if (box) {
      const POPUP_MARGIN = 120;
      await page.screenshot({
        path: shot,
        clip: {
          x     : Math.max(0, box.x - 4),
          y     : Math.max(0, box.y - POPUP_MARGIN),
          width : box.width + 8,
          height: box.height + POPUP_MARGIN + 4,
        },
      });
    } else {
      await page.screenshot({ path: shot });
    }
  } else {
    await page.screenshot({ path: shot });
  }
  log("📸", `  截图 → ${path.basename(shot)}`);

  // 读取行数：优先使用预知值（来自 data-tooltip-html），否则读 popup
  let lines = knownLines;
  if (lines === null) {
    lines = await extractLinesFromPopup(page, cell);
  }
  if (lines !== null) {
    daily[dateKey] = lines;
    log("💬", `  行数 → ${lines.toLocaleString()}`);
  } else {
    log("⚠️ ", `  未提取到行数`);
  }
}

/** 从 popup/tooltip/属性中提取 Lines Edited 数值 */
async function extractLinesFromPopup(page, cell) {
  // 1) 可见 tooltip 元素
  for (const sel of [
    '[role="tooltip"]',
    '[class*="tooltip"i]',
    '[class*="popover"i]',
    '[class*="popup"i]',
    '[class*="hint"i]',
  ]) {
    const el = page.locator(sel).last();
    if (!(await el.count())) continue;
    const txt  = await el.innerText().catch(() => "");
    const nums = txt.match(/[\d,]+/g);
    if (nums) {
      // 取最大数（"8,968 Lines Edited" 中的 8968）
      const val = Math.max(...nums.map(n => parseInt(n.replace(/,/g,""), 10)));
      if (!isNaN(val) && val > 0) return val;
    }
  }

  // 2) 格子属性
  for (const attr of ["data-value", "data-count", "aria-label", "title"]) {
    const v = await cell.getAttribute(attr).catch(() => null);
    if (!v) continue;
    const nums = v.match(/[\d,]+/g);
    if (nums) {
      const val = Math.max(...nums.map(n => parseInt(n.replace(/,/g,""), 10)));
      if (!isNaN(val) && val > 0) return val;
    }
  }

  return null;
}

// ─────────────────────────── Part 2：Usage CSV ──────────────────────────────
/** 在日历选择器中点击指定日期（支持跨月翻页） */
async function pickCalendarDate(page, date) {
  const TBODY_XPATH  = "/html/body/main/div/div[2]/div/div/div[2]/div/div[2]/div/div[1]/div[2]/div/div[1]/div/div/table/tbody";
  const HEADER_XPATH = "/html/body/main/div/div[2]/div/div/div[2]/div/div[2]/div/div[1]/div[2]/div/div[1]/div/div/div/div[1]";
  const PREV_XPATH   = "/html/body/main/div/div[2]/div/div/div[2]/div/div[2]/div/div[1]/div[2]/div/div[1]/div/div/div/div[2]/button[1]";
  const NEXT_XPATH   = "/html/body/main/div/div[2]/div/div/div[2]/div/div[2]/div/div[1]/div[2]/div/div[1]/div/div/div/div[2]/button[2]";
  const MONTHS_EN    = ["January","February","March","April","May","June",
                        "July","August","September","October","November","December"];

  const targetMonth = MONTHS_EN[date.getMonth()];
  const targetYear  = date.getFullYear();
  const targetDay   = date.getDate();

  // 翻页直到显示目标月份（最多翻 24 次）
  for (let i = 0; i < 24; i++) {
    const header = await page.locator(`xpath=${HEADER_XPATH}`).innerText().catch(() => "");
    if (header.includes(targetMonth) && header.includes(String(targetYear))) break;

    const m = header.match(/(\w+)\s+(\d{4})/);
    if (!m) break;
    const shownTime  = new Date(parseInt(m[2]), MONTHS_EN.indexOf(m[1])).getTime();
    const targetTime = new Date(targetYear, date.getMonth()).getTime();
    if (targetTime < shownTime) {
      await page.locator(`xpath=${PREV_XPATH}`).click();
    } else {
      await page.locator(`xpath=${NEXT_XPATH}`).click();
    }
    await page.waitForTimeout(100);
  }

  // 在 tbody 中找到文本恰好为目标日的 td 并点击
  const cells = page.locator(`xpath=${TBODY_XPATH}`).locator("td");
  const n = await cells.count();
  for (let i = 0; i < n; i++) {
    const cell = cells.nth(i);
    const text = (await cell.innerText().catch(() => "")).trim();
    if (text === String(targetDay)) {
      await cell.click();
      log("📅", `  点击日期: ${fmt(date)} (${targetDay})`);
      return;
    }
  }
  log("⚠️ ", `  未找到日历格子: ${fmt(date)}`);
}

async function collectCsv(page, ctx, start, end) {
  section("Part 2 — Usage CSV 导出");

  // ── 通过 URL 参数设置日期范围 ─────────────────────────────────────────────
  const usageUrl = `https://cursor.com/cn/dashboard/usage?from=${fmt(start)}&to=${fmt(end)}`;
  log("🌐", `跳转 dashboard/usage，日期范围: ${fmt(start)} → ${fmt(end)}`);
  log("🌐", `URL: ${usageUrl}`);
  await page.goto(usageUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  log("🌐", `当前 URL: ${page.url()}`);

  if (!page.url().includes("dashboard")) {
    log("❌", "未登录，退出 CSV 导出流程");
    return null;
  }
  log("✅", "已在 usage 页，日期范围已通过 URL 参数指定");

  // ── 找 Export CSV 按钮 ────────────────────────────────────────────────────
  log("🔍", "查找 Export CSV 按钮…");
  let exportBtn = null;
  for (const sel of [
    'button:has-text("Export CSV")',
    'button:has-text("导出 CSV")',
    'button:has-text("导出CSV")',
    'a:has-text("Export CSV")',
    'button:has-text("Export")',
    '[data-testid*="export"i]',
  ]) {
    const b = page.locator(sel).first();
    if (await b.count()) {
      exportBtn = b;
      log("✅", `  找到按钮: ${sel}`);
      break;
    }
  }

  if (!exportBtn) {
    log("❌", "未找到 Export CSV 按钮，保存调试截图");
    await page.screenshot({ path: path.join(DESKTOP, "cursor_usage_debug.png") });
    return null;
  }

  // ── 触发下载 ──────────────────────────────────────────────────────────────
  log("⬇️ ", "点击 Export CSV，等待下载…");
  let download;
  try {
    [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      exportBtn.click(),
    ]);
  } catch (e) {
    log("❌", `下载失败: ${e.message}`);
    return null;
  }

  const tmpPath  = await download.path();
  const filename = download.suggestedFilename() || "cursor_usage.csv";
  const dest     = path.join(SHOTS_DIR, filename);
  copyFileSync(tmpPath, dest);
  log("✅", `CSV 已保存 → ${dest}`);
  return dest;
}

// ─────────────────────────── 汇总：行数 ─────────────────────────────────────
function reportLineEdits(daily, start, end) {
  section("汇总 — AI Line Edits 行数");


  if (Object.keys(daily).length === 0) {
    log("⚠️ ", "未能提取到行数数据，请手动查看截图");
    return 0;
  }

  let total = 0;
  const maxVal = Math.max(...Object.values(daily), 1);
  console.log("");
  for (const d of eachDay(start, end)) {
    const key = fmt(d);
    const n   = daily[key] ?? 0;
    const bar = "█".repeat(Math.round((n / maxVal) * 20));
    console.log(
      `  ${key} 周${DAY[d.getDay()]}  ` +
      `${String(n.toLocaleString()).padStart(8)} 行  ${bar}`
    );
    total += n;
  }
  console.log(`  ${"─".repeat(46)}`);
  console.log(`  ${"合计".padEnd(20)}  ${String(total.toLocaleString()).padStart(8)} 行`);
  log("✅", `行数汇总完成，总计 ${total.toLocaleString()} 行`);
  return total;
}

// ─────────────────────────── 汇总：Token ────────────────────────────────────
function reportTokens(csvPath, start, end) {
  section("汇总 — Token 用量");

  if (!csvPath || !existsSync(csvPath)) {
    log("⚠️ ", "无 CSV 文件可分析");
    return { total: 0, daily: {} };
  }
  log("📄", `读取: ${csvPath}`);

  let rows;
  try {
    const content = readFileSync(csvPath, "utf-8");
    rows = csvParse(content, { columns: true, skip_empty_lines: true, bom: true });
  } catch (e) {
    log("❌", `CSV 解析失败: ${e.message}`);
    return { total: 0, daily: {} };
  }

  if (rows.length === 0) { log("⚠️ ", "CSV 为空"); return { total: 0, daily: {} }; }

  const COL = "Total Tokens";
  // 自动检测日期列
  const DATE_COLS = ["Date", "Timestamp", "Created At", "Time", "date", "timestamp", "created_at"];
  const dateCol = DATE_COLS.find(c => c in (rows[0] ?? {}));
  log("📊", `行数: ${rows.length}，求和列: "${COL}"，日期列: "${dateCol ?? "未找到"}"`);

  let total = 0;
  const daily = {};

  for (const row of rows) {
    const raw = (row[COL] ?? "").toString().replace(/,/g, "").trim();
    const n   = parseInt(raw, 10);
    if (isNaN(n)) continue;
    total += n;

    if (dateCol) {
      const d = new Date(row[dateCol]);
      if (!isNaN(d.getTime())) {
        const key = fmt(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
        daily[key] = (daily[key] ?? 0) + n;
      }
    }
  }

  const wan = (total / 10_000).toFixed(2);
  console.log(`\n  Token 总量: ${total.toLocaleString()}`);
  console.log(`  Token 总量: ${wan} w（万）`);

  // 按日输出
  if (start && end && Object.keys(daily).length > 0) {
    const maxVal = Math.max(...Object.values(daily), 1);
    console.log("");
    for (const d of eachDay(start, end)) {
      const key  = fmt(d);
      const n    = daily[key] ?? 0;
      const bar  = "█".repeat(Math.round((n / maxVal) * 20));
      const wan2 = (n / 10_000).toFixed(2);
      console.log(
        `  ${key} 周${DAY[d.getDay()]}  ` +
        `${String(n.toLocaleString()).padStart(10)} token  ${wan2.padStart(7)} w  ${bar}`
      );
    }
    console.log(`  ${"─".repeat(56)}`);
    console.log(`  ${"合计".padEnd(24)}  ${String(total.toLocaleString()).padStart(10)} token  ${wan.padStart(7)} w`);
  }

  log("✅", `Token 汇总完成: ${wan} w`);
  return { total, daily };
}

// ─────────────────────────── 主流程 ─────────────────────────────────────────
async function main() {
  // 每次运行前清空截图目录
  if (existsSync(SHOTS_DIR)) {
    rmSync(SHOTS_DIR, { recursive: true, force: true });
    log("🗑 ", `已删除旧目录: ${SHOTS_DIR}`);
  }

  // 解析运行模式与日期区间
  // --periode YYYYMMDD-YYYYMMDD  指定任意区间
  // --weekly                     上周四～本周三（或今天）
  // --day YYYYMMDD               指定某天（start=end=该天）
  // （无参数）                    当天（start=end=today）
  let start, end;
  const args = process.argv;

  const parse8 = (s) => new Date(
    parseInt(s.slice(0, 4), 10),
    parseInt(s.slice(4, 6), 10) - 1,
    parseInt(s.slice(6, 8), 10),
  );

  const periodeIdx = args.indexOf("--periode");
  const periodeVal = periodeIdx !== -1
    ? args[periodeIdx + 1]
    : args.find(a => a.startsWith("--periode="))?.split("=")[1];

  const dayIdx = args.indexOf("--day");
  const dayVal = dayIdx !== -1
    ? args[dayIdx + 1]
    : args.find(a => a.startsWith("--day="))?.split("=")[1];

  if (periodeVal) {
    const parts = periodeVal.split("-");
    if (parts.length !== 2 || parts[0].length !== 8 || parts[1].length !== 8) {
      log("❌", `--periode 格式错误，应为 YYYYMMDD-YYYYMMDD，收到: ${periodeVal}`);
      process.exit(1);
    }
    start = parse8(parts[0]);
    end   = parse8(parts[1]);
    log("📅", `--periode 指定区间: ${fmt(start)} → ${fmt(end)}`);
  } else if (args.includes("--weekly")) {
    [start, end] = weekRange();
    log("📅", `--weekly 区间: ${fmt(start)} → ${fmt(end)}`);
  } else if (dayVal) {
    if (dayVal.length !== 8) {
      log("❌", `--day 格式错误，应为 YYYYMMDD，收到: ${dayVal}`);
      process.exit(1);
    }
    start = end = parse8(dayVal);
    log("📅", `--day 指定日期: ${fmt(start)}`);
  } else {
    const now = new Date();
    start = end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    log("📅", `当天统计: ${fmt(start)}`);
  }

  // 根据日期范围构造截图目录名（mmdd 或 mmdd-mmdd）
  const mmdd = d => `${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  const dirSuffix = fmt(start) === fmt(end)
    ? mmdd(start)
    : `${mmdd(start)}-${mmdd(end)}`;
  SHOTS_DIR = path.join(DESKTOP, `cursor_stats_${dirSuffix}`);

  section("Cursor 周统计采集器");
  const now = new Date();
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  log("📅", `今天: ${fmt(todayLocal)} 周${DAY[todayLocal.getDay()]}`);
  log("📅", `统计周期: ${fmt(start)} 周${DAY[start.getDay()]} → ${fmt(end)} 周${DAY[end.getDay()]}`);
  log("📁", `桌面路径: ${DESKTOP}`);

  const browser = await launchBrowser();
  const ctx     = await newContext(browser);
  const page    = await ctx.newPage();

  // 页面级错误日志
  page.on("pageerror", e  => log("🐛", `页面错误: ${e.message}`));
  page.on("console",   msg => {
    if (msg.type() === "error") log("🐛", `控制台错误: ${msg.text()}`);
  });

  let daily   = {};
  let csvPath = null;

  try {
    // ── Part 1 ──────────────────────────────────────────────────────────────
    const ok = await ensureLoggedIn(page, ctx);
    if (!ok) {
      log("❌", "登录失败，终止");
      const closeTimeout = new Promise(r => setTimeout(r, 2000));
      await Promise.race([
        (async () => { await ctx.close().catch(() => {}); await browser.close(); })(),
        closeTimeout,
      ]);
      return;
    }
    daily = await collectLineEdits(page, start, end);

    // ── Part 2 ──────────────────────────────────────────────────────────────
    csvPath = await collectCsv(page, ctx, start, end);
  } catch (e) {
    log("❌", `运行时异常: ${e.message}`);
    console.error(e);
  } finally {
    log("🔒", "开始关闭浏览器");
    // 关闭前保存最新 session（运行过程中 token 可能已刷新）
    try {
      const state = await ctx.storageState();
      writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
      log("💾", `session 已更新 → ${SESSION_FILE}`);
    } catch (e) {
      log("⚠️", `session 保存失败: ${e.message}`);
    }
    const closeTimeout = new Promise(r => setTimeout(r, 2000));
    await Promise.race([
      (async () => { await ctx.close().catch(() => {}); await browser.close(); })(),
      closeTimeout,
    ]);
    log("🔒", "浏览器已关闭");
  }

  // ── 汇总报告 ───────────────────────────────────────────────────────────────
  const lineEditsTotal = reportLineEdits(daily, start, end);
  const tokensResult   = reportTokens(csvPath, start, end);

  // ── 写入汇总 JSON ──────────────────────────────────────────────────────────
  const fmtCompact = (d) => fmt(d).replace(/-/g, "");
  const dataFile = path.join(SHOTS_DIR, `cursor_usage_${fmtCompact(start)}_${fmtCompact(end)}.json`);
  const output = {
    period    : { start: fmt(start), end: fmt(end) },
    lineEdits : { total: lineEditsTotal, daily },
    tokens    : { total: tokensResult.total, daily: tokensResult.daily },
  };
  mkdirSync(SHOTS_DIR, { recursive: true });
  writeFileSync(dataFile, JSON.stringify(output, null, 2));
  log("💾", `汇总数据已写入 → ${path.basename(dataFile)}`);

  section("完成");
  log("✅", "所有任务执行完毕");
  log("📂", `结果已保存到 ${SHOTS_DIR}`);
}

main().catch(e => { log("❌", "Fatal:", e.message); console.error(e); process.exit(1); });
