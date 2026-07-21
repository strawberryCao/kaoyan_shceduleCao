import { invoke } from "@tauri-apps/api/core";
import "./style.css";

type ItemStatus = "pending" | "processing" | "auto" | "auto-reviewed" | "manual" | "failed" | "done";

type PassResult = {
  stage: string;
  model: string;
  raw_value: string | null;
  normalized: string | null;
  uncertain: boolean;
  valid: boolean;
  note: string;
};

type AnalysisResult = {
  status: "auto" | "auto-reviewed" | "manual" | "failed";
  suggested_number: string | null;
  candidates: string[];
  reason: string;
  passes: PassResult[];
};

type QueueItem = {
  path: string;
  status: ItemStatus;
  analysis?: AnalysisResult;
  finalNumber: string;
  error?: string;
};

type Settings = {
  profileId: string;
  baseUrl: string;
  firstModel: string;
  reviewModel: string;
  strictModel: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  maxDimension: number;
  firstPrompt: string;
  reviewPrompt: string;
  strictPrompt: string;
  numberPattern: string;
  separator: string;
  numberPadding: number;
  uppercase: boolean;
  removeSpaces: boolean;
  filenameTemplate: string;
  sequenceStart: number;
  sequenceDigits: number;
  batchName: string;
};

const DEFAULT_PROMPTS = {
  first: `你是生产图片中的缸号读取器。只读取图片中明确可见的缸号，不要根据格式、上下文或常识猜测。看不清的字符必须保留为 ?。如果发现多个可能的缸号，全部放入 multiple_candidates。严格返回 JSON：{"cylinder_number":"字符串或null","uncertain":true或false,"uncertain_characters":["字符位置或候选"],"multiple_candidates":["候选"],"evidence":"简短说明"}。不要输出 Markdown。`,
  review: `请独立完成一次缸号字符核验，不得参考其他模型的答案。逐字符读取图片中实际可见的编号；无法确定的字符用 ?，不要补全或猜测。严格返回 JSON：{"cylinder_number":"字符串或null","uncertain":true或false,"uncertain_characters":["字符位置或候选"],"multiple_candidates":["候选"],"evidence":"简短说明"}。不要输出 Markdown。`,
  strict: `这是一次加强复核。只根据图片像素读取缸号，重点检查容易混淆的 0/O、1/I、5/S、6/8、B/8。只要存在实质字符不确定就标记 uncertain=true，不要用编号规律猜答案。严格返回 JSON：{"cylinder_number":"字符串或null","uncertain":true或false,"uncertain_characters":["字符位置或候选"],"multiple_candidates":["候选"],"evidence":"简短说明"}。不要输出 Markdown。`,
};

const DEFAULT_SETTINGS: Settings = {
  profileId: "default",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  firstModel: "qwen3.7-plus",
  reviewModel: "qwen-vl-ocr",
  strictModel: "qwen3.7-plus",
  temperature: 0.05,
  maxTokens: 800,
  timeoutSeconds: 90,
  maxDimension: 2048,
  firstPrompt: DEFAULT_PROMPTS.first,
  reviewPrompt: DEFAULT_PROMPTS.review,
  strictPrompt: DEFAULT_PROMPTS.strict,
  numberPattern: "^[A-Z0-9]+(?:-[A-Z0-9]+)*$",
  separator: "-",
  numberPadding: 0,
  uppercase: true,
  removeSpaces: true,
  filenameTemplate: "{{缸号}}_{{序号}}",
  sequenceStart: 1,
  sequenceDigits: 3,
  batchName: "",
};

const byId = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element #${id}`);
  return value as T;
};
const input = (id: string) => byId<HTMLInputElement>(id);
const textarea = (id: string) => byId<HTMLTextAreaElement>(id);
const button = (id: string) => byId<HTMLButtonElement>(id);

const queueBody = byId<HTMLTableSectionElement>("queue-body");
const emptyState = byId<HTMLElement>("empty-state");
const queueWrap = byId<HTMLElement>("queue-table-wrap");
const toastNode = byId<HTMLElement>("toast");
const previewDialog = byId<HTMLDialogElement>("preview-dialog");
const previewImage = byId<HTMLImageElement>("preview-image");
const previewLoading = byId<HTMLElement>("preview-loading");

let queue: QueueItem[] = [];
let outputDirectory = "";
let stopRequested = false;
let toastTimer: number | undefined;

function toast(message: string, error = false) {
  window.clearTimeout(toastTimer);
  toastNode.textContent = message;
  toastNode.classList.toggle("error", error);
  toastNode.classList.add("visible");
  toastTimer = window.setTimeout(() => toastNode.classList.remove("visible"), 3600);
}

function asNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadSavedSettings(): Settings {
  try {
    const stored = localStorage.getItem("cylinder-renamer.settings.v1");
    if (!stored) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } as Settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function applySettings(settings: Settings) {
  input("base-url").value = settings.baseUrl;
  input("first-model").value = settings.firstModel;
  input("review-model").value = settings.reviewModel;
  input("strict-model").value = settings.strictModel;
  input("temperature").value = String(settings.temperature);
  input("max-tokens").value = String(settings.maxTokens);
  input("timeout").value = String(settings.timeoutSeconds);
  input("max-dimension").value = String(settings.maxDimension);
  textarea("first-prompt").value = settings.firstPrompt;
  textarea("review-prompt").value = settings.reviewPrompt;
  textarea("strict-prompt").value = settings.strictPrompt;
  input("number-pattern").value = settings.numberPattern;
  input("separator").value = settings.separator;
  input("number-padding").value = String(settings.numberPadding);
  input("uppercase").checked = settings.uppercase;
  input("remove-spaces").checked = settings.removeSpaces;
  input("filename-template").value = settings.filenameTemplate;
  input("sequence-start").value = String(settings.sequenceStart);
  input("sequence-digits").value = String(settings.sequenceDigits);
  input("batch-name").value = settings.batchName;
}

function readSettings(): Settings {
  return {
    profileId: "default",
    baseUrl: input("base-url").value.trim(),
    firstModel: input("first-model").value.trim(),
    reviewModel: input("review-model").value.trim(),
    strictModel: input("strict-model").value.trim(),
    temperature: asNumber(input("temperature").value, DEFAULT_SETTINGS.temperature),
    maxTokens: asNumber(input("max-tokens").value, DEFAULT_SETTINGS.maxTokens),
    timeoutSeconds: asNumber(input("timeout").value, DEFAULT_SETTINGS.timeoutSeconds),
    maxDimension: asNumber(input("max-dimension").value, DEFAULT_SETTINGS.maxDimension),
    firstPrompt: textarea("first-prompt").value.trim() || DEFAULT_PROMPTS.first,
    reviewPrompt: textarea("review-prompt").value.trim() || DEFAULT_PROMPTS.review,
    strictPrompt: textarea("strict-prompt").value.trim() || DEFAULT_PROMPTS.strict,
    numberPattern: input("number-pattern").value.trim(),
    separator: input("separator").value || "-",
    numberPadding: asNumber(input("number-padding").value, 0),
    uppercase: input("uppercase").checked,
    removeSpaces: input("remove-spaces").checked,
    filenameTemplate: input("filename-template").value.trim() || "{{缸号}}_{{序号}}",
    sequenceStart: asNumber(input("sequence-start").value, 1),
    sequenceDigits: asNumber(input("sequence-digits").value, 3),
    batchName: input("batch-name").value.trim(),
  };
}

function saveSettings() {
  localStorage.setItem("cylinder-renamer.settings.v1", JSON.stringify(readSettings()));
  refreshQueueNames();
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function splitFileName(path: string) {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, extension: "" };
  return { base: name.slice(0, dot), extension: name.slice(dot) };
}

function sanitizeFilename(name: string) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/-+/g, "-")
    .trim()
    .slice(0, 180) || "未命名";
}

function finalNameFor(item: QueueItem, index: number) {
  if (!item.finalNumber) return "—";
  const settings = readSettings();
  const source = splitFileName(item.path);
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const sequence = String(settings.sequenceStart + index).padStart(settings.sequenceDigits, "0");
  let rendered = settings.filenameTemplate
    .replaceAll("{{缸号}}", item.finalNumber)
    .replaceAll("{{序号}}", sequence)
    .replaceAll("{{日期}}", date)
    .replaceAll("{{原文件名}}", source.base)
    .replaceAll("{{批次}}", settings.batchName)
    .replaceAll("{{扩展名}}", source.extension);
  rendered = sanitizeFilename(rendered);
  if (!settings.filenameTemplate.includes("{{扩展名}}") && source.extension) rendered += source.extension;
  return rendered;
}

function statusLabel(item: QueueItem) {
  const labels: Record<ItemStatus, [string, string]> = {
    pending: ["待处理", "status-pending"],
    processing: ["识别中", "status-processing"],
    auto: ["自动通过", "status-auto"],
    "auto-reviewed": ["复核通过", "status-reviewed"],
    manual: ["需要填写", "status-manual"],
    failed: ["无法识别", "status-failed"],
    done: ["已执行", "status-auto"],
  };
  return labels[item.status];
}

function resultText(item: QueueItem) {
  if (item.status === "pending") return "—";
  if (item.status === "processing") return "正在调用模型…";
  const candidates = item.analysis?.candidates ?? [];
  return item.analysis?.suggested_number || candidates.join(" / ") || "未识别";
}

function rowMarkup(item: QueueItem, index: number) {
  const [label, className] = statusLabel(item);
  const reason = item.analysis?.reason || item.error || "";
  const finalCell = item.status === "manual" || item.status === "failed"
    ? `<input class="manual-number" data-manual-index="${index}" value="${escapeHtml(item.finalNumber)}" placeholder="填写正确缸号" />`
    : `<span class="result-main">${escapeHtml(item.finalNumber || "—")}</span>`;
  return `<tr data-index="${index}">
    <td><div class="file-name" title="${escapeHtml(item.path)}">${escapeHtml(fileName(item.path))}</div></td>
    <td><span class="result-main">${escapeHtml(resultText(item))}</span><span class="result-note" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span></td>
    <td><span class="status-pill ${className}">${label}</span></td>
    <td>${finalCell}</td>
    <td><div class="new-name" title="${escapeHtml(finalNameFor(item, index))}">${escapeHtml(finalNameFor(item, index))}</div></td>
    <td><button class="icon-button" data-preview-index="${index}" title="查看图片">⌕</button></td>
  </tr>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] || char);
}

function renderQueue() {
  const hasItems = queue.length > 0;
  emptyState.classList.toggle("hidden", hasItems);
  queueWrap.classList.toggle("hidden", !hasItems);
  queueBody.innerHTML = queue.map(rowMarkup).join("");
  byId("source-summary").textContent = hasItems ? `已导入 ${queue.length} 张图片` : "尚未导入图片";
  button("analyze").disabled = !hasItems || queue.every((item) => item.status !== "pending");
  updateStats();
}

function refreshRow(index: number) {
  const row = queueBody.querySelector<HTMLTableRowElement>(`tr[data-index="${index}"]`);
  if (row && queue[index]) row.outerHTML = rowMarkup(queue[index], index);
  updateStats();
}

function refreshQueueNames() {
  queue.forEach((_, index) => refreshRow(index));
}

function updateStats() {
  const auto = queue.filter((item) => item.status === "auto" || item.status === "auto-reviewed" || item.status === "done").length;
  const manual = queue.filter((item) => item.status === "manual" || item.status === "failed").length;
  const pending = queue.filter((item) => item.status === "pending" || item.status === "processing").length;
  byId("stat-total").textContent = String(queue.length);
  byId("stat-auto").textContent = String(auto);
  byId("stat-manual").textContent = String(manual);
  byId("stat-pending").textContent = String(pending);
  button("execute").disabled = !queue.some((item) => Boolean(item.finalNumber) && item.status !== "pending" && item.status !== "processing");
}

function aiConfig(settings: Settings) {
  return {
    profile_id: settings.profileId,
    base_url: settings.baseUrl,
    first_model: settings.firstModel,
    review_model: settings.reviewModel,
    strict_model: settings.strictModel,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    timeout_seconds: settings.timeoutSeconds,
    max_dimension: settings.maxDimension,
    first_prompt: settings.firstPrompt,
    review_prompt: settings.reviewPrompt,
    strict_prompt: settings.strictPrompt,
  };
}

function numberRules(settings: Settings) {
  return {
    pattern: settings.numberPattern,
    separator: settings.separator,
    number_padding: settings.numberPadding,
    uppercase: settings.uppercase,
    remove_spaces: settings.removeSpaces,
  };
}

async function refreshKeyStatus() {
  try {
    const exists = await invoke<boolean>("has_api_key", { profileId: "default" });
    const node = byId("key-status");
    node.textContent = exists ? "Key 已安全保存" : "未保存 Key";
    node.className = `badge ${exists ? "ready" : "muted"}`;
    input("api-key").placeholder = exists ? "已保存；填写新值可覆盖" : "填写后保存到系统凭据库";
  } catch (error) {
    toast(String(error), true);
  }
}

button("select-images").addEventListener("click", async () => {
  try {
    const paths = await invoke<string[]>("pick_images");
    const existing = new Set(queue.map((item) => item.path));
    for (const path of paths) if (!existing.has(path)) queue.push({ path, status: "pending", finalNumber: "" });
    renderQueue();
  } catch (error) {
    toast(`选择图片失败：${String(error)}`, true);
  }
});

button("clear-list").addEventListener("click", () => {
  if (queue.some((item) => item.status === "processing")) return;
  queue = [];
  renderQueue();
});

button("select-output").addEventListener("click", async () => {
  try {
    const selected = await invoke<string | null>("pick_directory");
    if (selected) {
      outputDirectory = selected;
      byId("output-path").textContent = selected;
      byId("output-path").title = selected;
    }
  } catch (error) {
    toast(`选择输出目录失败：${String(error)}`, true);
  }
});

button("save-key").addEventListener("click", async () => {
  const apiKey = input("api-key").value.trim();
  if (!apiKey) return toast("请先填写 API Key", true);
  try {
    await invoke("save_api_key", { profileId: "default", apiKey });
    input("api-key").value = "";
    await refreshKeyStatus();
    toast("API Key 已保存到系统凭据库");
  } catch (error) {
    toast(`保存失败：${String(error)}`, true);
  }
});

button("clear-key").addEventListener("click", async () => {
  try {
    await invoke("clear_api_key", { profileId: "default" });
    await refreshKeyStatus();
    toast("已清除 API Key");
  } catch (error) {
    toast(`清除失败：${String(error)}`, true);
  }
});

button("test-api").addEventListener("click", async () => {
  saveSettings();
  button("test-api").disabled = true;
  try {
    const message = await invoke<string>("test_connection", { config: aiConfig(readSettings()) });
    toast(message);
  } catch (error) {
    toast(`连接失败：${String(error)}`, true);
  } finally {
    button("test-api").disabled = false;
  }
});

button("analyze").addEventListener("click", async () => {
  saveSettings();
  stopRequested = false;
  button("analyze").disabled = true;
  button("stop").disabled = false;
  const settings = readSettings();
  for (let index = 0; index < queue.length; index += 1) {
    if (stopRequested) break;
    const item = queue[index];
    if (!item || item.status !== "pending") continue;
    item.status = "processing";
    refreshRow(index);
    try {
      const analysis = await invoke<AnalysisResult>("analyze_image", {
        path: item.path,
        config: aiConfig(settings),
        rules: numberRules(settings),
      });
      item.analysis = analysis;
      item.status = analysis.status;
      item.finalNumber = analysis.suggested_number || "";
    } catch (error) {
      item.status = "failed";
      item.error = String(error);
      item.finalNumber = "";
    }
    refreshRow(index);
  }
  button("stop").disabled = true;
  renderQueue();
  toast(stopRequested ? "识别已暂停，可再次点击继续" : "识别队列处理完成");
});

button("stop").addEventListener("click", () => {
  stopRequested = true;
  button("stop").disabled = true;
});

queueBody.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  const indexValue = target.dataset.manualIndex;
  if (indexValue === undefined) return;
  const index = Number(indexValue);
  const item = queue[index];
  if (!item) return;
  item.finalNumber = target.value.trim();
  const nameNode = target.closest("tr")?.querySelector<HTMLElement>(".new-name");
  if (nameNode) {
    nameNode.textContent = finalNameFor(item, index);
    nameNode.title = finalNameFor(item, index);
  }
  updateStats();
});

queueBody.addEventListener("click", async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-preview-index]");
  if (!target) return;
  const index = Number(target.dataset.previewIndex);
  const item = queue[index];
  if (!item) return;
  byId("preview-title").textContent = fileName(item.path);
  previewImage.hidden = true;
  previewLoading.hidden = false;
  previewDialog.showModal();
  try {
    previewImage.src = await invoke<string>("load_thumbnail", { path: item.path, maxSide: 1100 });
    previewImage.hidden = false;
    previewLoading.hidden = true;
  } catch (error) {
    previewLoading.textContent = `预览失败：${String(error)}`;
  }
});

button("close-preview").addEventListener("click", () => previewDialog.close());

button("execute").addEventListener("click", async () => {
  const items = queue
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => Boolean(item.finalNumber) && item.status !== "pending" && item.status !== "processing" && item.status !== "done")
    .map(({ item, index }) => ({ source_path: item.path, target_name: finalNameFor(item, index) }));
  if (!items.length) return toast("没有可执行的结果", true);
  button("execute").disabled = true;
  try {
    const summary = await invoke<{ completed: number; skipped: number; messages: string[] }>("execute_plan", {
      request: {
        output_dir: outputDirectory || null,
        operation_mode: byId<HTMLSelectElement>("operation-mode").value,
        items,
      },
    });
    const executedPaths = new Set(items.map((item) => item.source_path));
    queue.forEach((item) => { if (executedPaths.has(item.path)) item.status = "done"; });
    renderQueue();
    toast(`已完成 ${summary.completed} 个文件${summary.skipped ? `，跳过 ${summary.skipped} 个` : ""}`);
  } catch (error) {
    toast(`执行失败：${String(error)}`, true);
  } finally {
    updateStats();
  }
});

button("undo").addEventListener("click", async () => {
  try {
    const summary = await invoke<{ completed: number; skipped: number }>("undo_last");
    toast(`已撤销 ${summary.completed} 个文件${summary.skipped ? `，${summary.skipped} 个无法自动撤销` : ""}`);
  } catch (error) {
    toast(`撤销失败：${String(error)}`, true);
  }
});

button("restore-prompts").addEventListener("click", () => {
  textarea("first-prompt").value = DEFAULT_PROMPTS.first;
  textarea("review-prompt").value = DEFAULT_PROMPTS.review;
  textarea("strict-prompt").value = DEFAULT_PROMPTS.strict;
  saveSettings();
});

button("export-config").addEventListener("click", () => {
  const settings = readSettings();
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, settings }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "缸号图片整理器配置.json";
  anchor.click();
  URL.revokeObjectURL(url);
  toast("配置已导出；文件中不包含 API Key");
});

button("import-config").addEventListener("click", () => input("config-file").click());
input("config-file").addEventListener("change", async () => {
  const file = input("config-file").files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as { settings?: Partial<Settings> };
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) } as Settings;
    applySettings(settings);
    saveSettings();
    toast("配置已导入；API Key 仍使用本机保存的值");
  } catch (error) {
    toast(`配置文件无效：${String(error)}`, true);
  } finally {
    input("config-file").value = "";
  }
});

for (const node of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(".settings-panel input, .settings-panel textarea, .settings-panel select")) {
  if (node.id === "api-key" || node.id === "config-file") continue;
  node.addEventListener("change", saveSettings);
}

applySettings(loadSavedSettings());
renderQueue();
void refreshKeyStatus();
