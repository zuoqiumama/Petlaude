"use strict";

// ── Settings tab: AI Pet Studio ──────────────────────────────────────────────
// Configure an image-gen API, pick a reference image, and generate companion
// action animations (all at once or per action). Talks to main via
// window.studioAPI (see preload-settings.js); generation progress streams in
// through studioAPI.onProgress and updates per-action badges in place.
//
// Markup follows the settings design system: h1/.subtitle page header,
// .section > .section-title + .section-rows cards, .row layouts with
// .row-text/.row-control, .soft-btn buttons, .studio-input fields
// (styles in settings.css under "AI Pet Studio").

(function initSettingsTabStudio(root) {
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
    apiStatus: "",        // last save/test status line
    progressUnsub: null,
    seq: 0,
  };

  const STAGE_ORDER = ["start", "generated", "extracted", "assembled", "written"];
  const CATEGORY_LABEL_KEYS = {
    "idle-life": "studioCatIdle",
    context: "studioCatContext",
    touch: "studioCatTouch",
  };

  function t(key) { return helpers.t(key); }

  function loadInitial() {
    if (!window.studioAPI) return;
    const seq = ++view.seq;
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
    return `${idx + 1}/${STAGE_ORDER.length}`;
  }

  function updateBadge(actionId) {
    const el = view.badgeEls.get(actionId);
    if (!el || !el.isConnected) return;
    const status = view.statuses.get(actionId);
    el.textContent = stageLabel(status);
    el.classList.toggle("studio-badge-error", !!(status && status.stage === "error"));
    el.classList.toggle("studio-badge-done", !!(status && status.stage === "written"));
    el.classList.toggle(
      "studio-badge-busy",
      !!(status && status.stage && status.stage !== "error" && status.stage !== "written"),
    );
  }

  // ── building blocks ──

  function section(titleKey) {
    const wrap = document.createElement("div");
    wrap.className = "section";
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = t(titleKey);
    wrap.appendChild(title);
    const rows = document.createElement("div");
    rows.className = "section-rows";
    wrap.appendChild(rows);
    return { wrap, rows };
  }

  function row(rows, labelText, descText) {
    const r = document.createElement("div");
    r.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = labelText;
    text.appendChild(label);
    if (descText) {
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.textContent = descText;
      text.appendChild(desc);
    }
    const control = document.createElement("div");
    control.className = "row-control";
    r.appendChild(text);
    r.appendChild(control);
    rows.appendChild(r);
    return { row: r, text, control };
  }

  function input(value, { type = "text", placeholder = "" } = {}) {
    const el = document.createElement("input");
    el.type = type;
    el.value = value || "";
    el.placeholder = placeholder;
    el.className = "studio-input";
    el.spellcheck = false;
    el.autocomplete = "off";
    return el;
  }

  function softBtn(label, { accent = false } = {}) {
    const btn = document.createElement("button");
    btn.className = accent ? "soft-btn accent" : "soft-btn";
    btn.textContent = label;
    return btn;
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

  // ── sections ──

  function renderApiSection(parent) {
    const { wrap, rows } = section("studioApiSection");
    const draft = getDraft();

    const urlRow = row(rows, t("studioBaseUrl"));
    const urlInput = input(draft.baseUrl, { placeholder: "https://…" });
    urlInput.addEventListener("input", () => { getDraft().baseUrl = urlInput.value; });
    urlRow.control.appendChild(urlInput);

    const modelRow = row(rows, t("studioModel"));
    const modelInput = input(draft.model, { placeholder: "gpt-image-2" });
    modelInput.addEventListener("input", () => { getDraft().model = modelInput.value; });
    modelRow.control.appendChild(modelInput);

    const keyDesc = view.cfg && view.cfg.hasKey ? t("studioApiKeySaved") : "";
    const keyRow = row(rows, t("studioApiKey"), keyDesc);
    const keyInput = input("", { type: "password", placeholder: "sk-…" });
    keyInput.addEventListener("input", () => { getDraft().apiKey = keyInput.value; });
    keyRow.control.appendChild(keyInput);

    const actionRow = row(rows, "", view.apiStatus || "");
    const statusDesc = actionRow.text.querySelector(".row-desc")
      || actionRow.text.appendChild(Object.assign(document.createElement("span"), { className: "row-desc" }));
    actionRow.text.querySelector(".row-label").remove();

    const testBtn = softBtn(t("studioTest"));
    const saveBtn = softBtn(t("studioSave"), { accent: true });
    actionRow.control.appendChild(testBtn);
    actionRow.control.appendChild(saveBtn);

    saveBtn.addEventListener("click", () => {
      const d = getDraft();
      saveBtn.disabled = true;
      window.studioAPI.saveConfig({ baseUrl: d.baseUrl, model: d.model, apiKey: d.apiKey }).then((res) => {
        saveBtn.disabled = false;
        if (res && res.status === "ok") {
          view.apiStatus = res.keyPersisted === false && d.apiKey
            ? t("studioKeyNotPersisted")
            : t("studioSaved");
          view.draft = null;
          loadInitial();
        } else {
          view.apiStatus = (res && res.message) || t("toastSaveFailed");
        }
        statusDesc.textContent = view.apiStatus;
      });
    });

    testBtn.addEventListener("click", () => {
      testBtn.disabled = true;
      statusDesc.textContent = "…";
      window.studioAPI.testConfig().then((res) => {
        testBtn.disabled = false;
        view.apiStatus = res && res.status === "ok"
          ? (res.note ? `${t("studioTestOk")} (${res.note})` : t("studioTestOk"))
          : ((res && res.message) || t("studioTestFailed"));
        statusDesc.textContent = view.apiStatus;
      });
    });

    parent.appendChild(wrap);
  }

  function renderReferenceSection(parent) {
    const { wrap, rows } = section("studioReferenceSection");

    const nameRow = row(rows, t("studioPetName"));
    const nameInput = input(view.petName, { placeholder: t("studioPetNamePlaceholder") });
    nameInput.addEventListener("input", () => { view.petName = nameInput.value; });
    nameRow.control.appendChild(nameInput);

    const refDesc = view.reference ? view.reference.path : t("studioNoReference");
    const pickRow = row(rows, t("studioPickImage"), refDesc);
    if (view.reference) {
      const preview = document.createElement("img");
      preview.className = "studio-ref-preview";
      preview.alt = "";
      preview.src = view.reference.dataUrl;
      pickRow.control.appendChild(preview);
    }
    const pickBtn = softBtn(t("studioPickImage"));
    pickRow.control.appendChild(pickBtn);
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

    parent.appendChild(wrap);
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

  function actionCard(action) {
    const card = document.createElement("div");
    card.className = "studio-action-card";

    const head = document.createElement("div");
    head.className = "studio-action-head";
    const name = document.createElement("span");
    name.className = "studio-action-name";
    name.textContent = action.id;
    const badge = document.createElement("span");
    badge.className = "studio-badge";
    view.badgeEls.set(action.id, badge);
    head.appendChild(name);
    head.appendChild(badge);
    card.appendChild(head);

    const meta = document.createElement("span");
    meta.className = "studio-action-meta";
    meta.textContent = `${action.frames}f · ${Math.round(action.durationMs / 100) / 10}s`;
    card.appendChild(meta);

    const btn = softBtn(t("studioGenerate"));
    btn.classList.add("studio-action-btn");
    btn.disabled = !canGenerate();
    btn.addEventListener("click", () => runGenerate({ actionId: action.id }, [action.id]));
    card.appendChild(btn);

    updateBadge(action.id);
    return card;
  }

  function renderActionsSection(parent) {
    const { wrap, rows } = section("studioActionsSection");

    const allRow = row(rows, t("studioGenerateAll"));
    const allBtn = softBtn(view.busy ? t("studioGenerating") : t("studioGenerateAll"), { accent: true });
    allBtn.disabled = !canGenerate();
    allBtn.addEventListener("click", () => {
      runGenerate({ mode: "all" }, (view.actions || []).map((a) => a.id));
    });
    allRow.control.appendChild(allBtn);

    view.badgeEls.clear();
    const gridRow = document.createElement("div");
    gridRow.className = "row studio-actions-row";
    for (const [cat, labelKey] of Object.entries(CATEGORY_LABEL_KEYS)) {
      const actions = (view.actions || []).filter((a) => a.category === cat);
      if (!actions.length) continue;
      const catTitle = document.createElement("div");
      catTitle.className = "studio-cat-title";
      catTitle.textContent = t(labelKey);
      gridRow.appendChild(catTitle);

      const grid = document.createElement("div");
      grid.className = "studio-action-grid";
      for (const action of actions) grid.appendChild(actionCard(action));
      gridRow.appendChild(grid);
    }
    rows.appendChild(gridRow);

    parent.appendChild(wrap);
  }

  function render(parent) {
    subscribeProgress();
    if (!view.cfgLoaded || !view.actions) loadInitial();

    const h1 = document.createElement("h1");
    h1.textContent = t("sidebarStudio");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("studioIntro");
    parent.appendChild(subtitle);

    renderApiSection(parent);
    renderReferenceSection(parent);
    renderActionsSection(parent);
  }

  function init(core) {
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.studio = { render };
  }

  root.ClawdSettingsTabStudio = { init };
})(globalThis);
