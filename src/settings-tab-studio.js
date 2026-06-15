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
    draftDirty: false,    // user edited the form before/after config loaded
    busy: false,          // any generation in flight
    statuses: new Map(),  // actionId -> { stage, error?, previewUrl?, previewFrameUrls? }
    badgeEls: new Map(),  // actionId -> badge element (live while tab mounted)
    apiStatus: "",        // last save/test status line
    progressUnsub: null,
    cfgRequested: false,  // getConfig() in flight or done (fire once)
    actionsRequested: false, // getActions() in flight or done (fire once)
  };

  const STAGE_ORDER = ["start", "generated", "extracted", "assembled", "written"];
  const STUDIO_IMAGE_MODEL = "gpt-image-2";
  const CATEGORY_LABEL_KEYS = {
    core: "studioCatCore",
    sleep: "studioCatSleep",
    mini: "studioCatMini",
    "idle-life": "studioCatIdle",
    context: "studioCatContext",
    touch: "studioCatTouch",
  };

  function t(key) { return helpers.t(key); }

  // Fetch config and the action manifest exactly once each. Each request guards
  // its own in-flight flag so a re-render triggered by one resolving (e.g.
  // getConfig) never re-issues — or invalidates — the other. (A shared sequence
  // counter here caused an infinite render loop: getConfig resolved first, its
  // re-render bumped the counter, and the still-pending getActions was discarded
  // as stale on every pass, so actions never loaded and render() kept retrying.)
  function loadInitial() {
    if (!window.studioAPI) return;
    if (!view.cfgRequested) {
      view.cfgRequested = true;
      window.studioAPI.getConfig().then((cfg) => {
        view.cfg = cfg;
        view.cfgLoaded = true;
        if (!view.draftDirty) {
          view.draft = {
            baseUrl: (cfg && cfg.baseUrl) || "",
            model: STUDIO_IMAGE_MODEL,
            apiKey: "",
          };
        }
        ops.requestRender({ content: true });
      }).catch(() => { view.cfgRequested = false; });
    }
    if (!view.actionsRequested) {
      view.actionsRequested = true;
      window.studioAPI.getActions().then((actions) => {
        view.actions = actions;
        restoreGeneratedStatuses()
          .catch(() => {})
          .finally(() => ops.requestRender({ content: true }));
      }).catch(() => { view.actionsRequested = false; });
    }
  }

  function refreshConfig() {
    view.cfgRequested = false;
    view.cfgLoaded = false;
    loadInitial();
  }

  async function restoreGeneratedStatuses() {
    if (!window.studioAPI || typeof window.studioAPI.getActionStatuses !== "function") return;
    const petName = view.petName.trim();
    const statuses = await window.studioAPI.getActionStatuses({ petName });
    if (!Array.isArray(statuses)) return;
    if (!view.petName.trim() && statuses[0] && statuses[0].petName) view.petName = statuses[0].petName;
    for (const status of statuses) {
      if (!status || !status.actionId) continue;
      view.statuses.set(status.actionId, {
        stage: status.stage || "written",
        error: null,
        previewUrl: status.previewUrl || null,
        previewFrameUrls: Array.isArray(status.previewFrameUrls) ? status.previewFrameUrls : null,
      });
    }
  }

  function subscribeProgress() {
    if (view.progressUnsub || !window.studioAPI) return;
    view.progressUnsub = window.studioAPI.onProgress((evt) => {
      if (!evt || !evt.actionId) return;
      const prev = view.statuses.get(evt.actionId) || {};
      view.statuses.set(evt.actionId, {
        ...prev,
        stage: evt.stage,
        error: evt.error || null,
        previewUrl: evt.previewUrl || prev.previewUrl || null,
        previewFrameUrls: Array.isArray(evt.previewFrameUrls)
          ? evt.previewFrameUrls
          : (prev.previewFrameUrls || null),
      });
      const badge = view.badgeEls.get(evt.actionId);
      if ((evt.stage === "start" || evt.stage === "written" || evt.stage === "error") && badge && badge.isConnected) {
        ops.requestRender({ content: true });
      } else {
        updateBadge(evt.actionId);
      }
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

  function applyBadgeState(el, status) {
    el.textContent = stageLabel(status);
    el.classList.toggle("studio-badge-error", !!(status && status.stage === "error"));
    el.classList.toggle("studio-badge-done", !!(status && status.stage === "written"));
    el.classList.toggle(
      "studio-badge-busy",
      !!(status && status.stage && status.stage !== "error" && status.stage !== "written"),
    );
  }

  function updateBadge(actionId) {
    const el = view.badgeEls.get(actionId);
    if (!el || !el.isConnected) return;
    const status = view.statuses.get(actionId);
    applyBadgeState(el, status);
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
        model: STUDIO_IMAGE_MODEL,
        apiKey: "",
      };
    }
    return view.draft;
  }

  // ── sections ──

  function renderApiSection(parent) {
    const { wrap, rows } = section("studioApiSection");
    const draft = getDraft();
    let statusDesc = null;

    function markDraftEdited() {
      view.draftDirty = true;
      view.apiStatus = "";
      if (statusDesc) statusDesc.textContent = "";
    }

    const urlRow = row(rows, t("studioBaseUrl"));
    const urlInput = input(draft.baseUrl, { placeholder: "https://…" });
    urlInput.addEventListener("input", () => {
      getDraft().baseUrl = urlInput.value;
      markDraftEdited();
    });
    urlRow.control.appendChild(urlInput);

    const modelRow = row(rows, t("studioModel"));
    draft.model = STUDIO_IMAGE_MODEL;
    const modelInput = input(STUDIO_IMAGE_MODEL, { placeholder: STUDIO_IMAGE_MODEL });
    modelInput.disabled = true;
    modelRow.control.appendChild(modelInput);

    const keyDesc = view.cfg && view.cfg.hasKey ? t("studioApiKeySaved") : "";
    const keyRow = row(rows, t("studioApiKey"), keyDesc);
    const keyInput = input("", { type: "password", placeholder: "sk-…" });
    keyInput.addEventListener("input", () => {
      getDraft().apiKey = keyInput.value;
      markDraftEdited();
    });
    keyRow.control.appendChild(keyInput);

    const actionRow = row(rows, "", view.apiStatus || "");
    statusDesc = actionRow.text.querySelector(".row-desc")
      || actionRow.text.appendChild(Object.assign(document.createElement("span"), { className: "row-desc" }));
    actionRow.text.querySelector(".row-label").remove();

    const testBtn = softBtn(t("studioTest"));
    const saveBtn = softBtn(t("studioSave"), { accent: true });
    actionRow.control.appendChild(testBtn);
    actionRow.control.appendChild(saveBtn);

    saveBtn.addEventListener("click", async () => {
      const d = getDraft();
      saveBtn.disabled = true;
      try {
        const res = await window.studioAPI.saveConfig({ baseUrl: d.baseUrl, model: d.model, apiKey: d.apiKey });
        if (res && res.status === "ok") {
          view.apiStatus = res.keyPersisted === false && d.apiKey
            ? t("studioKeyNotPersisted")
            : t("studioSaved");
          view.draft = null;
          view.draftDirty = false;
          refreshConfig();
        } else {
          view.apiStatus = (res && res.message) || t("toastSaveFailed");
        }
        statusDesc.textContent = view.apiStatus;
      } catch (err) {
        view.apiStatus = (err && err.message) || t("toastSaveFailed");
        statusDesc.textContent = view.apiStatus;
      } finally {
        saveBtn.disabled = false;
      }
    });

    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      statusDesc.textContent = "…";
      try {
        const d = getDraft();
        const res = await window.studioAPI.testConfig({
          baseUrl: d.baseUrl,
          model: d.model,
          apiKey: d.apiKey,
        });
        view.apiStatus = res && res.status === "ok"
          ? (res.note ? `${t("studioTestOk")} (${res.note})` : t("studioTestOk"))
          : ((res && res.message) || t("studioTestFailed"));
        statusDesc.textContent = view.apiStatus;
      } catch (err) {
        view.apiStatus = (err && err.message) || t("studioTestFailed");
        statusDesc.textContent = view.apiStatus;
      } finally {
        testBtn.disabled = false;
      }
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
    pickBtn.addEventListener("click", async () => {
      try {
        const res = await window.studioAPI.pickReference();
        if (res && res.status === "ok") {
          view.reference = { path: res.path, dataUrl: res.dataUrl };
          if (!view.petName.trim() && res.suggestedName) view.petName = res.suggestedName;
          await restoreGeneratedStatuses();
          ops.requestRender({ content: true });
        } else if (res && res.status === "error") {
          ops.showToast(res.message, { error: true });
        }
      } catch (err) {
        ops.showToast((err && err.message) || t("toastSaveFailed"), { error: true });
      }
    });

    // Use the active pet's look as the reference: lets the Studio derive a
    // complete AI pet from a built-in pet (same identity, full action set).
    const currentPetBtn = softBtn(t("studioUseCurrentPet"));
    pickRow.control.appendChild(currentPetBtn);
    currentPetBtn.addEventListener("click", async () => {
      if (typeof window.studioAPI.useCurrentPet !== "function") return;
      currentPetBtn.disabled = true;
      try {
        const res = await window.studioAPI.useCurrentPet();
        if (res && res.status === "ok") {
          view.reference = { path: res.path, dataUrl: res.dataUrl };
          if (!view.petName.trim() && res.suggestedName) view.petName = res.suggestedName;
          await restoreGeneratedStatuses();
          ops.requestRender({ content: true });
        } else if (res && res.status === "error") {
          ops.showToast(res.message, { error: true });
        }
      } catch (err) {
        ops.showToast((err && err.message) || t("toastSaveFailed"), { error: true });
      } finally {
        currentPetBtn.disabled = false;
      }
    });

    parent.appendChild(wrap);
  }

  function canGenerate() {
    return !!(view.cfg && view.cfg.hasKey && view.cfg.baseUrl && view.reference && !view.busy);
  }

  function isActionGenerating(actionId) {
    const status = view.statuses.get(actionId);
    return !!(
      view.busy
      && status
      && status.stage
      && status.stage !== "error"
      && status.stage !== "written"
    );
  }

  function hasActionPreview(status) {
    return !!(
      status
      && (
        status.previewUrl
        || (Array.isArray(status.previewFrameUrls) && status.previewFrameUrls.length > 0)
      )
    );
  }

  function runGenerate(payload, badgeActionIds) {
    if (!canGenerate()) {
      ops.showToast(t("studioConfigIncomplete"), { error: true });
      return;
    }
    view.busy = true;
    if (payload.mode !== "all") {
      for (const id of badgeActionIds) {
        const prev = view.statuses.get(id) || {};
        view.statuses.set(id, { ...prev, stage: "start", error: null });
      }
    }
    ops.requestRender({ content: true });
    window.studioAPI.generate({
      ...payload,
      petName: view.petName,
      referencePath: view.reference.path,
    }).then((res) => {
      view.busy = false;
      if (res && res.status === "ok") {
        const completed = [];
        if (res.result && res.result.actionId) completed.push(res.result);
        if (res.summary && Array.isArray(res.summary.results)) completed.push(...res.summary.results);
        for (const result of completed) {
          const prev = view.statuses.get(result.actionId) || {};
          view.statuses.set(result.actionId, {
            ...prev,
            stage: "written",
            error: null,
            previewUrl: result.previewUrl || prev.previewUrl || null,
            previewFrameUrls: Array.isArray(result.previewFrameUrls)
              ? result.previewFrameUrls
              : (prev.previewFrameUrls || null),
          });
        }
        if (res.summary && res.summary.failed && res.summary.failed.length) {
          for (const f of res.summary.failed) {
            const prev = view.statuses.get(f.actionId) || {};
            view.statuses.set(f.actionId, { ...prev, stage: "error", error: f.error });
          }
          const summaryMsg = `${t("studioPartialDone")} (${res.summary.ok}/${res.summary.total})`;
          ops.showToast(res.summary.aborted ? `${summaryMsg} — ${t("studioStoppedEarly")}` : summaryMsg, { error: true });
        } else {
          ops.showToast(t("studioDoneSwitchHint"));
        }
      } else {
        const failedIds = payload.mode === "all" ? [] : badgeActionIds;
        for (const id of failedIds) {
          const prev = view.statuses.get(id) || {};
          view.statuses.set(id, {
            ...prev,
            stage: "error",
            error: (res && res.message) || "generation failed",
          });
        }
        ops.showToast((res && res.message) || t("toastSaveFailed"), { error: true });
      }
      ops.requestRender({ content: true });
    }).catch((err) => {
      view.busy = false;
      const failedIds = payload.mode === "all" ? [] : badgeActionIds;
      for (const id of failedIds) {
        const prev = view.statuses.get(id) || {};
        view.statuses.set(id, {
          ...prev,
          stage: "error",
          error: (err && err.message) || "generation failed",
        });
      }
      ops.showToast((err && err.message) || t("toastSaveFailed"), { error: true });
      ops.requestRender({ content: true });
    });
  }

  function appendImagePreview(preview, action, url) {
    const image = document.createElement("img");
    image.className = "studio-action-preview-image";
    image.src = url;
    image.alt = `${action.id} ${t("studioPreviewAlt")}`;
    image.loading = "lazy";
    image.decoding = "async";
    preview.appendChild(image);
  }

  function previewTimeline(action, frameCount) {
    const sequence = Array.isArray(action.previewSequence)
      && action.previewSequence.length > 0
      && action.previewSequence.every((index) => Number.isInteger(index) && index >= 0 && index < frameCount)
      ? action.previewSequence
      : Array.from({ length: frameCount }, (_, index) => index);
    const keyTimes = Array.isArray(action.previewKeyTimes)
      && action.previewKeyTimes.length === sequence.length + 1
      ? action.previewKeyTimes
      : [...sequence.map((_, index) => index / sequence.length), 1];
    return { sequence, keyTimes };
  }

  function appendAnimatedPreview(preview, action, frameUrls) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("class", "studio-action-preview-animation");
    svg.setAttribute("viewBox", "0 0 512 512");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${action.id} ${t("studioPreviewAlt")}`);

    const { sequence, keyTimes } = previewTimeline(action, frameUrls.length);
    for (let index = 0; index < frameUrls.length; index += 1) {
      const image = document.createElementNS(namespace, "image");
      image.setAttribute("width", "512");
      image.setAttribute("height", "512");
      image.setAttribute("href", frameUrls[index]);
      image.setAttribute("opacity", "0");

      const values = sequence.map((frameIndex) => (frameIndex === index ? "1" : "0"));
      values.push(values[values.length - 1]);
      const animate = document.createElementNS(namespace, "animate");
      animate.setAttribute("attributeName", "opacity");
      animate.setAttribute("values", values.join(";"));
      animate.setAttribute("keyTimes", keyTimes.join(";"));
      animate.setAttribute("dur", `${action.durationMs}ms`);
      animate.setAttribute("repeatCount", "indefinite");
      animate.setAttribute("calcMode", "discrete");
      image.appendChild(animate);
      svg.appendChild(image);
    }
    preview.appendChild(svg);
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
    badge.setAttribute("aria-live", "polite");
    view.badgeEls.set(action.id, badge);
    head.appendChild(name);
    head.appendChild(badge);
    card.appendChild(head);

    const status = view.statuses.get(action.id);
    applyBadgeState(badge, status);
    const preview = document.createElement("div");
    preview.className = "studio-action-preview";
    const frameUrls = status && Array.isArray(status.previewFrameUrls)
      ? status.previewFrameUrls.filter((url) => typeof url === "string" && url)
      : [];
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (frameUrls.length > 1 && !reduceMotion && typeof document.createElementNS === "function") {
      appendAnimatedPreview(preview, action, frameUrls);
    } else if (frameUrls.length > 0) {
      appendImagePreview(preview, action, frameUrls[0]);
    } else if (status && status.previewUrl) {
      appendImagePreview(preview, action, status.previewUrl);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "studio-action-preview-empty";
      placeholder.textContent = t("studioPreviewPending");
      preview.appendChild(placeholder);
    }
    card.appendChild(preview);

    const meta = document.createElement("span");
    meta.className = "studio-action-meta";
    meta.textContent = `${action.frames}f · ${Math.round(action.durationMs / 100) / 10}s`;
    card.appendChild(meta);

    // Persist the real failure reason on the card — the toast is transient, so
    // without this a failed action only ever shows the word "Failed".
    if (status && status.stage === "error" && status.error) {
      const errEl = document.createElement("span");
      errEl.className = "studio-action-error";
      errEl.textContent = status.error;
      errEl.title = status.error;
      card.appendChild(errEl);
    }

    const generating = isActionGenerating(action.id);
    const done = !!(status && (status.stage === "written" || hasActionPreview(status)));
    const btn = softBtn(generating
      ? t("studioGenerating")
      : (done ? t("studioRegenerate") : t("studioGenerate")));
    btn.classList.add("studio-action-btn");
    if (generating) {
      btn.classList.add("studio-action-btn-loading");
      if (typeof btn.setAttribute === "function") btn.setAttribute("aria-busy", "true");
      const spinner = document.createElement("span");
      spinner.className = "studio-btn-spinner";
      if (typeof spinner.setAttribute === "function") spinner.setAttribute("aria-hidden", "true");
      btn.appendChild(spinner);
    }
    btn.disabled = !canGenerate();
    btn.addEventListener("click", () => runGenerate({ actionId: action.id }, [action.id]));
    card.appendChild(btn);

    return card;
  }

  function renderActionsSection(parent) {
    const { wrap, rows } = section("studioActionsSection");

    const totalActions = (view.actions || []).length;
    const completedActions = (view.actions || []).filter((action) => (
      hasActionPreview(view.statuses.get(action.id))
    )).length;
    const allRow = row(
      rows,
      t("studioGenerateAll"),
      `${completedActions}/${totalActions} ${t("studioStatusDone")}`,
    );
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
