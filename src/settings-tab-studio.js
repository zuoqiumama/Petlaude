"use strict";

// ── Settings tab: AI Pet Studio ──────────────────────────────────────────────
// Configure an image-gen API, pick a reference image, and generate companion
// action animations (all at once or per action). Talks to main via
// window.studioAPI (see preload-settings.js); generation progress streams in
// through studioAPI.onProgress and updates per-action badges in place.

(function initSettingsTabStudio(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  const view = {
    cfg: null,            // { baseUrl, model, hasKey }
    cfgLoaded: false,
    actions: null,        // manifest summaries
    reference: null,      // { path, dataUrl }
    petName: "",
    draft: null,          // config form draft
    busy: false,          // any generation in flight
    statuses: new Map(),  // actionId -> { stage, error? }
    badgeEls: new Map(),  // actionId -> badge element (live while tab mounted)
    progressUnsub: null,
    seq: 0,
  };

  const STAGE_ORDER = ["start", "generated", "extracted", "assembled", "written"];

  function t(key) { return helpers.t(key); }

  function loadInitial() {
    const seq = ++view.seq;
    if (window.studioAPI) {
      window.studioAPI.getConfig().then((cfg) => {
        if (seq !== view.seq) return;
        view.cfg = cfg;
        view.cfgLoaded = true;
        ops.requestRender({ content: true });
      }).catch(() => {});
      if (!view.actions) {
        window.studioAPI.getActions().then((actions) => {
          if (seq !== view.seq) return;
          view.actions = actions;
          ops.requestRender({ content: true });
        }).catch(() => {});
      }
    }
  }

  function subscribeProgress() {
    if (view.progressUnsub || !window.studioAPI) return;
    view.progressUnsub = window.studioAPI.onProgress((evt) => {
      if (!evt || !evt.actionId) return;
      const prev = view.statuses.get(evt.actionId) || {};
      view.statuses.set(evt.actionId, { ...prev, stage: evt.stage, error: evt.error || null });
      updateBadge(evt.actionId);
    });
  }

  function stageLabel(status) {
    if (!status || !status.stage) return "";
    if (status.stage === "error") return t("studioStatusFailed");
    if (status.stage === "written") return t("studioStatusDone");
    const idx = STAGE_ORDER.indexOf(status.stage);
    if (idx < 0) return status.stage;
    return `${t("studioGenerating")} ${idx + 1}/${STAGE_ORDER.length}`;
  }

  function updateBadge(actionId) {
    const el = view.badgeEls.get(actionId);
    if (!el || !el.isConnected) return;
    const status = view.statuses.get(actionId);
    el.textContent = stageLabel(status);
    el.classList.toggle("studio-badge-error", !!(status && status.stage === "error"));
    el.classList.toggle("studio-badge-done", !!(status && status.stage === "written"));
  }

  function field(labelText, inputEl) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = labelText;
    label.style.minWidth = "120px";
    row.appendChild(label);
    row.appendChild(inputEl);
    return row;
  }

  function textInput(value, { type = "text", placeholder = "" } = {}) {
    const input = document.createElement("input");
    input.type = type;
    input.value = value || "";
    input.placeholder = placeholder;
    input.style.flex = "1";
    input.spellcheck = false;
    return input;
  }

  function getDraft() {
    if (!view.draft) {
      view.draft = {
        baseUrl: (view.cfg && view.cfg.baseUrl) || "",
        model: (view.cfg && view.cfg.model) || "",
        apiKey: "",
      };
    }
    return view.draft;
  }

  function renderApiSection(container) {
    const section = document.createElement("div");
    section.className = "studio-section";
    const title = document.createElement("h3");
    title.textContent = t("studioApiSection");
    section.appendChild(title);

    const draft = getDraft();
    const baseUrlInput = textInput(draft.baseUrl, { placeholder: "https://…" });
    baseUrlInput.addEventListener("input", () => { getDraft().baseUrl = baseUrlInput.value; });
    section.appendChild(field(t("studioBaseUrl"), baseUrlInput));

    const modelInput = textInput(draft.model, { placeholder: "gpt-image-2" });
    modelInput.addEventListener("input", () => { getDraft().model = modelInput.value; });
    section.appendChild(field(t("studioModel"), modelInput));

    const keyPlaceholder = view.cfg && view.cfg.hasKey ? t("studioApiKeySaved") : "sk-…";
    const keyInput = textInput("", { type: "password", placeholder: keyPlaceholder });
    keyInput.autocomplete = "off";
    keyInput.addEventListener("input", () => { getDraft().apiKey = keyInput.value; });
    section.appendChild(field(t("studioApiKey"), keyInput));

    const actions = document.createElement("div");
    actions.className = "row";
    const saveBtn = document.createElement("button");
    saveBtn.textContent = t("studioSave");
    const testBtn = document.createElement("button");
    testBtn.textContent = t("studioTest");
    const status = document.createElement("span");
    status.className = "row-desc";
    status.style.marginLeft = "8px";
    actions.appendChild(saveBtn);
    actions.appendChild(testBtn);
    actions.appendChild(status);
    section.appendChild(actions);

    saveBtn.addEventListener("click", () => {
      const d = getDraft();
      saveBtn.disabled = true;
      window.studioAPI.saveConfig({ baseUrl: d.baseUrl, model: d.model, apiKey: d.apiKey }).then((res) => {
        saveBtn.disabled = false;
        if (res && res.status === "ok") {
          status.textContent = res.keyPersisted === false && d.apiKey
            ? t("studioKeyNotPersisted")
            : t("studioSaved");
          view.draft = null;
          loadInitial();
        } else {
          status.textContent = (res && res.message) || t("toastSaveFailed");
        }
      });
    });

    testBtn.addEventListener("click", () => {
      testBtn.disabled = true;
      status.textContent = "…";
      window.studioAPI.testConfig().then((res) => {
        testBtn.disabled = false;
        status.textContent = res && res.status === "ok"
          ? (res.note ? `${t("studioTestOk")} (${res.note})` : t("studioTestOk"))
          : ((res && res.message) || t("studioTestFailed"));
      });
    });

    container.appendChild(section);
  }

  function renderReferenceSection(container) {
    const section = document.createElement("div");
    section.className = "studio-section";
    const title = document.createElement("h3");
    title.textContent = t("studioReferenceSection");
    section.appendChild(title);

    const nameInput = textInput(view.petName, { placeholder: t("studioPetNamePlaceholder") });
    nameInput.addEventListener("input", () => { view.petName = nameInput.value; });
    section.appendChild(field(t("studioPetName"), nameInput));

    const row = document.createElement("div");
    row.className = "row";
    const pickBtn = document.createElement("button");
    pickBtn.textContent = t("studioPickImage");
    row.appendChild(pickBtn);

    const preview = document.createElement("img");
    preview.alt = "";
    preview.style.cssText = "width:72px;height:72px;object-fit:contain;margin-left:12px;border-radius:8px;background:rgba(127,127,127,.12)";
    if (view.reference) preview.src = view.reference.dataUrl;
    else preview.style.display = "none";
    row.appendChild(preview);

    const hint = document.createElement("span");
    hint.className = "row-desc";
    hint.style.marginLeft = "8px";
    hint.textContent = view.reference ? view.reference.path : t("studioNoReference");
    row.appendChild(hint);

    pickBtn.addEventListener("click", () => {
      window.studioAPI.pickReference().then((res) => {
        if (res && res.status === "ok") {
          view.reference = { path: res.path, dataUrl: res.dataUrl };
          ops.requestRender({ content: true });
        } else if (res && res.status === "error") {
          ops.showToast(res.message, { error: true });
        }
      });
    });

    section.appendChild(row);
    container.appendChild(section);
  }

  function canGenerate() {
    return !!(view.cfg && view.cfg.hasKey && view.cfg.baseUrl && view.reference && !view.busy);
  }

  function runGenerate(payload, badgeActionIds) {
    if (!canGenerate()) {
      ops.showToast(t("studioConfigIncomplete"), { error: true });
      return;
    }
    view.busy = true;
    for (const id of badgeActionIds) {
      view.statuses.set(id, { stage: "start" });
      updateBadge(id);
    }
    ops.requestRender({ content: true });
    window.studioAPI.generate({
      ...payload,
      petName: view.petName,
      referencePath: view.reference.path,
    }).then((res) => {
      view.busy = false;
      if (res && res.status === "ok") {
        if (res.summary && res.summary.failed && res.summary.failed.length) {
          for (const f of res.summary.failed) {
            view.statuses.set(f.actionId, { stage: "error", error: f.error });
          }
          ops.showToast(`${t("studioPartialDone")} (${res.summary.ok}/${res.summary.total})`, { error: true });
        } else {
          ops.showToast(t("studioDoneSwitchHint"));
        }
      } else {
        ops.showToast((res && res.message) || t("toastSaveFailed"), { error: true });
      }
      ops.requestRender({ content: true });
    });
  }

  function renderActionsSection(container) {
    const section = document.createElement("div");
    section.className = "studio-section";
    const title = document.createElement("h3");
    title.textContent = t("studioActionsSection");
    section.appendChild(title);

    const allRow = document.createElement("div");
    allRow.className = "row";
    const allBtn = document.createElement("button");
    allBtn.textContent = view.busy ? t("studioGenerating") : t("studioGenerateAll");
    allBtn.disabled = !canGenerate();
    allBtn.addEventListener("click", () => {
      runGenerate({ mode: "all" }, (view.actions || []).map((a) => a.id));
    });
    allRow.appendChild(allBtn);
    section.appendChild(allRow);

    view.badgeEls.clear();
    const categories = [
      ["idle-life", t("studioCatIdle")],
      ["context", t("studioCatContext")],
      ["touch", t("studioCatTouch")],
    ];
    for (const [cat, label] of categories) {
      const catTitle = document.createElement("div");
      catTitle.className = "row-desc";
      catTitle.style.cssText = "margin-top:10px;font-weight:600";
      catTitle.textContent = label;
      section.appendChild(catTitle);

      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;margin-top:6px";
      for (const action of (view.actions || []).filter((a) => a.category === cat)) {
        const card = document.createElement("div");
        card.style.cssText = "border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px";

        const head = document.createElement("div");
        head.style.cssText = "display:flex;justify-content:space-between;align-items:center";
        const name = document.createElement("span");
        name.textContent = action.id;
        name.style.fontWeight = "600";
        const badge = document.createElement("span");
        badge.className = "row-desc";
        view.badgeEls.set(action.id, badge);
        head.appendChild(name);
        head.appendChild(badge);
        card.appendChild(head);

        const meta = document.createElement("span");
        meta.className = "row-desc";
        meta.textContent = `${action.frames}f · ${Math.round(action.durationMs / 100) / 10}s`;
        card.appendChild(meta);

        const btn = document.createElement("button");
        btn.textContent = t("studioGenerate");
        btn.disabled = !canGenerate();
        btn.addEventListener("click", () => runGenerate({ actionId: action.id }, [action.id]));
        card.appendChild(btn);

        grid.appendChild(card);
        updateBadge(action.id);
      }
      section.appendChild(grid);
    }

    container.appendChild(section);
  }

  function render(container) {
    subscribeProgress();
    if (!view.cfgLoaded || !view.actions) loadInitial();

    const wrap = document.createElement("div");
    wrap.className = "studio-tab";
    const intro = document.createElement("p");
    intro.className = "row-desc";
    intro.textContent = t("studioIntro");
    wrap.appendChild(intro);

    renderApiSection(wrap);
    renderReferenceSection(wrap);
    renderActionsSection(wrap);
    container.appendChild(wrap);
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.studio = { render };
  }

  root.ClawdSettingsTabStudio = { init };
})(globalThis);
