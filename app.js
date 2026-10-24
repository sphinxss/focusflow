/* FocusFlow — Pomodoro timer & task list
   Vanilla JS · localStorage · no build step */

(() => {
  "use strict";

  const STORAGE_KEY = "focusflow-v1";
  const RING_CIRCUMFERENCE = 2 * Math.PI * 138;

  const DEFAULTS = {
    focus: 25,
    short: 5,
    long: 15,
    interval: 4,
    autoBreaks: true,
    autoFocus: false,
    sound: true,
    notifications: false,
  };

  const MODES = {
    focus: { label: "Focus session", start: "Start focus", toast: "Focus session complete" },
    short: { label: "Short break", start: "Start break", toast: "Break's over — ready to focus?" },
    long: { label: "Long break", start: "Start break", toast: "Long break over — fresh start." },
  };

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const dateISO = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const state = {
    settings: { ...DEFAULTS },
    tasks: [],
    activeTaskId: null,
    sessions: [],
    cycle: 0,
    theme: "dark",
  };

  const timer = {
    mode: "focus",
    remaining: DEFAULTS.focus * 60,
    total: DEFAULTS.focus * 60,
    running: false,
    endAt: null,
  };

  let ticker = null;
  let audioCtx = null;
  let toastTimer = null;
  let restoredTimer = false;

  /* ---------- Storage ---------- */

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);

      if (saved.settings && typeof saved.settings === "object") {
        Object.keys(DEFAULTS).forEach((key) => {
          if (typeof saved.settings[key] === typeof DEFAULTS[key]) {
            state.settings[key] = saved.settings[key];
          }
        });
      }
      if (Array.isArray(saved.tasks)) {
        state.tasks = saved.tasks
          .filter((task) => task && typeof task.text === "string")
          .map((task) => ({
            id: String(task.id || id()),
            text: task.text.slice(0, 90),
            done: Boolean(task.done),
            pomos: Number(task.pomos) || 0,
            createdAt: Number(task.createdAt) || Date.now(),
          }));
      }
      if (typeof saved.activeTaskId === "string") state.activeTaskId = saved.activeTaskId;
      if (Array.isArray(saved.sessions)) {
        state.sessions = saved.sessions.filter((session) => session && session.date && Number.isFinite(Number(session.minutes)));
      }
      if (Number.isFinite(Number(saved.cycle))) state.cycle = Math.max(0, Number(saved.cycle));
      if (saved.theme === "light" || saved.theme === "dark") state.theme = saved.theme;

      if (saved.timer && typeof saved.timer === "object") {
        restoredTimer = true;
        const mode = ["focus", "short", "long"].includes(saved.timer.mode) ? saved.timer.mode : "focus";
        const total = Number(saved.timer.total);
        const remaining = Number(saved.timer.remaining);
        timer.mode = mode;
        timer.total = Number.isFinite(total) && total > 0 ? total : duration(mode);
        timer.remaining = Number.isFinite(remaining) && remaining >= 0 ? Math.min(remaining, timer.total) : timer.total;
        timer.running = Boolean(saved.timer.running) && Number.isFinite(Number(saved.timer.endAt));
        timer.endAt = timer.running ? Number(saved.timer.endAt) : null;
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          settings: state.settings,
          tasks: state.tasks,
          activeTaskId: state.activeTaskId,
          sessions: state.sessions.slice(-1000),
          cycle: state.cycle,
          theme: state.theme,
          timer: {
            mode: timer.mode,
            remaining: timer.remaining,
            total: timer.total,
            running: timer.running,
            endAt: timer.endAt,
          },
        })
      );
    } catch (err) {
      toast("Could not save — browser storage is unavailable.");
    }
  }

  function id() {
    if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return "task-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function duration(mode) {
    return Math.max(1, Math.round(Number(state.settings[mode]) || DEFAULTS[mode])) * 60;
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ---------- Timer ---------- */

  function formatTime(seconds) {
    const safe = Math.max(0, Math.round(seconds));
    return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(tick, 250);
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function startTimer() {
    if (timer.running) return;
    if (timer.remaining <= 0) timer.remaining = timer.total;
    ensureAudio();
    timer.running = true;
    timer.endAt = Date.now() + timer.remaining * 1000;
    startTicker();
    renderTimer();
    saveState();
  }

  function pauseTimer() {
    if (!timer.running) return;
    timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
    timer.running = false;
    timer.endAt = null;
    stopTicker();
    renderTimer();
    saveState();
  }

  function toggleTimer() {
    if (timer.running) pauseTimer();
    else startTimer();
  }

  function resetTimer() {
    stopTicker();
    timer.running = false;
    timer.endAt = null;
    timer.total = duration(timer.mode);
    timer.remaining = timer.total;
    renderAll();
    saveState();
    toast("Timer reset");
  }

  function tick() {
    if (!timer.running || !timer.endAt) return;
    const remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
    if (remaining !== timer.remaining) {
      timer.remaining = remaining;
      renderTimer();
    }
    if (remaining <= 0) {
      stopTicker();
      timer.running = false;
      timer.endAt = null;
      timer.remaining = 0;
      renderTimer();
      completeSession();
    }
  }

  function setMode(mode, options = {}) {
    const { autostart = false, quiet = false } = options;
    stopTicker();
    timer.mode = mode;
    timer.total = duration(mode);
    timer.remaining = timer.total;
    timer.running = false;
    timer.endAt = null;
    renderAll();
    saveState();
    if (!quiet) toast(mode === "focus" ? "Ready to focus" : "Break time");
    if (autostart) startTimer();
  }

  function completeSession() {
    const finishedMode = timer.mode;
    const wasFocus = finishedMode === "focus";

    if (wasFocus) {
      const task = state.tasks.find((item) => item.id === state.activeTaskId);
      state.sessions.push({
        date: dateISO(),
        minutes: Math.round(timer.total / 60),
        taskId: task ? task.id : null,
        completedAt: Date.now(),
      });
      if (task) task.pomos += 1;
      state.cycle += 1;
    }

    const interval = clampInt(state.settings.interval, 2, 10, DEFAULTS.interval);
    let next;
    if (wasFocus) next = state.cycle % interval === 0 ? "long" : "short";
    else next = "focus";

    const autoStart = wasFocus ? state.settings.autoBreaks : state.settings.autoFocus;
    playChime();
    notify(
      wasFocus ? "Focus session complete" : "Break complete",
      wasFocus
        ? `Nice work. ${next === "long" ? "Take a long break — you earned it." : "Time for a short break."}`
        : "Ready for the next focus session?"
    );

    setMode(next, { autostart: autoStart, quiet: true });
    toast(wasFocus ? (next === "long" ? "Long break earned. Step away." : "Focus complete. Take a short break.") : "Break's over. Ready to focus?");
  }

  function skipSession() {
    stopTicker();
    timer.running = false;
    timer.endAt = null;
    const next = timer.mode === "focus" ? "short" : "focus";
    setMode(next, { quiet: true });
    toast(next === "focus" ? "Skipped to focus" : "Skipped to a short break");
  }

  function renderTimer() {
    const remaining = Math.max(0, timer.remaining);
    $("timeDisplay").textContent = formatTime(remaining);
    $("modeLabel").textContent = MODES[timer.mode].label;

    const progress = timer.total > 0 ? remaining / timer.total : 0;
    $("ringProgress").style.strokeDasharray = String(RING_CIRCUMFERENCE);
    $("ringProgress").style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
    $("ringProgress").style.stroke = "";

    $("startLabel").textContent = timer.running
      ? "Pause"
      : remaining > 0 && remaining < timer.total
        ? "Resume"
        : MODES[timer.mode].start;
    $("startBtn").classList.toggle("is-running", timer.running);
    $("startBtn").setAttribute("aria-label", timer.running ? "Pause timer" : "Start timer");
    $("timerTitle").textContent = MODES[timer.mode].label + " timer";
    document.querySelector(".timer-card").classList.toggle("is-running", timer.running);
    $("liveDot").hidden = !timer.running;
    document.title = timer.running
      ? `${formatTime(remaining)} · ${timer.mode === "focus" ? "Focus" : "Break"} — FocusFlow`
      : "FocusFlow — Pomodoro Timer & Task List";

    document.querySelectorAll(".mode-tab").forEach((tab) => {
      const active = tab.dataset.mode === timer.mode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", String(active));
    });

    const interval = clampInt(state.settings.interval, 2, 10, DEFAULTS.interval);
    const filled = timer.mode === "long" ? interval : state.cycle % interval;
    $("cycleDots").innerHTML = Array.from({ length: interval }, (_, index) => `<i class="${index < filled ? "is-filled" : ""}"></i>`).join("");

    if (timer.mode === "focus") {
      const done = state.cycle % interval;
      const left = interval - done;
      $("roundLabel").textContent = `Round ${done + 1} of ${interval}`;
      $("cycleText").textContent = `${left} more focus session${left === 1 ? "" : "s"} until a long break.`;
    } else if (timer.mode === "long") {
      $("roundLabel").textContent = "You earned this";
      $("cycleText").textContent = "Step away, stretch, and come back refreshed.";
    } else {
      $("roundLabel").textContent = "Short reset";
      $("cycleText").textContent = "Breathe, hydrate, and look away from the screen.";
    }
  }

  /* ---------- Stats ---------- */

  function renderStats() {
    const today = dateISO();
    const todaySessions = state.sessions.filter((session) => session.date === today);
    const minutes = todaySessions.reduce((sum, session) => sum + Number(session.minutes || 0), 0);

    const dates = new Set(state.sessions.map((session) => session.date));
    let streak = 0;
    const cursor = new Date();
    if (!dates.has(dateISO(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (dates.has(dateISO(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    $("statSessions").textContent = String(todaySessions.length);
    $("statMinutes").innerHTML = `${minutes}<span>m</span>`;
    $("statStreak").innerHTML = `${streak}<span>d</span>`;
  }

  /* ---------- Tasks ---------- */

  function addTask(text) {
    const clean = text.trim().replace(/\s+/g, " ").slice(0, 90);
    if (!clean) return;
    const task = { id: id(), text: clean, done: false, pomos: 0, createdAt: Date.now() };
    state.tasks.push(task);
    if (!state.activeTaskId) state.activeTaskId = task.id;
    saveState();
    renderAll();
    toast("Task added");
  }

  function toggleTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    task.done = !task.done;
    if (task.done && state.activeTaskId === task.id) {
      const next = state.tasks.find((item) => !item.done);
      state.activeTaskId = next ? next.id : null;
    }
    saveState();
    renderAll();
    toast(task.done ? "Task complete. Nice." : "Task reopened");
  }

  function removeTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    if (!window.confirm(`Remove "${task.text}" from your list?`)) return;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    if (state.activeTaskId === taskId) {
      const next = state.tasks.find((item) => !item.done);
      state.activeTaskId = next ? next.id : null;
    }
    saveState();
    renderAll();
    toast("Task removed");
  }

  function selectTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || task.done) return;
    state.activeTaskId = task.id;
    saveState();
    renderAll();
    toast("Now focusing on: " + task.text);
  }

  function renderTasks() {
    const list = $("taskList");
    const total = state.tasks.length;
    const done = state.tasks.filter((task) => task.done).length;
    const left = total - done;

    if (state.activeTaskId && !state.tasks.some((task) => task.id === state.activeTaskId && !task.done)) {
      state.activeTaskId = state.tasks.find((task) => !task.done)?.id || null;
    }

    const ordered = [...state.tasks].sort((a, b) => Number(a.done) - Number(b.done));

    list.innerHTML = ordered
      .map((task) => {
        const isActive = task.id === state.activeTaskId && !task.done;
        const pomoLabel = `${task.pomos} session${task.pomos === 1 ? "" : "s"}`;
        return `<li class="task-item${task.done ? " is-done" : ""}${isActive ? " is-active" : ""}" data-id="${task.id}">
          <button class="task-check" type="button" data-action="toggle" aria-label="${task.done ? "Reopen" : "Complete"} ${escapeHTML(task.text)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>
          </button>
          <div class="task-main" role="button" tabindex="0" data-action="select" aria-label="${isActive ? "Active task: " : "Focus on "}${escapeHTML(task.text)}">
            <span class="task-text">${escapeHTML(task.text)}</span>
            <span class="task-meta">${pomoLabel}${isActive ? ' <span class="active-badge">Active</span>' : ""}</span>
          </div>
          <button class="task-delete" type="button" data-action="delete" aria-label="Remove ${escapeHTML(task.text)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/></svg>
          </button>
        </li>`;
      })
      .join("");

    $("tasksEmpty").hidden = total > 0;
    $("taskList").hidden = total === 0;
    $("taskCount").textContent = String(left);
    $("taskProgress").style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
    $("taskSummary").textContent = total === 0
      ? "Nothing on your list yet."
      : left === 0
        ? "Everything done — enjoy the win."
        : `${left} left · ${done} done`;

    renderActiveTask();
  }

  function renderActiveTask() {
    const box = $("activeTask");
    const task = state.tasks.find((item) => item.id === state.activeTaskId && !item.done);
    if (task) {
      box.classList.add("has-task");
      box.querySelector("p").innerHTML = `Focusing on <strong>${escapeHTML(task.text)}</strong>`;
    } else {
      box.classList.remove("has-task");
      box.querySelector("p").innerHTML = 'No task selected <span>Pick one from your list to stay on track.</span>';
    }
  }

  /* ---------- Rendering ---------- */

  function renderAll() {
    renderTimer();
    renderStats();
    renderTasks();
  }

  /* ---------- Settings ---------- */

  const settingsModal = $("settingsModal");

  function clampInt(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  function fillSettingsForm() {
    $("focusLength").value = state.settings.focus;
    $("shortLength").value = state.settings.short;
    $("longLength").value = state.settings.long;
    $("longInterval").value = state.settings.interval;
    $("autoBreaks").checked = Boolean(state.settings.autoBreaks);
    $("autoFocus").checked = Boolean(state.settings.autoFocus);
    $("soundToggle").checked = Boolean(state.settings.sound);
    $("notifyToggle").checked = Boolean(state.settings.notifications);
    $("notifyToggle").disabled = !("Notification" in window);
    $("settingsNote").hidden = true;
  }

  function openSettings() {
    fillSettingsForm();
    settingsModal.showModal();
  }

  function closeSettings() {
    if (settingsModal.open) settingsModal.close();
  }

  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsClose").addEventListener("click", closeSettings);
  settingsModal.addEventListener("click", (event) => {
    if (event.target === settingsModal) closeSettings();
  });

  $("defaultsBtn").addEventListener("click", () => {
    $("focusLength").value = DEFAULTS.focus;
    $("shortLength").value = DEFAULTS.short;
    $("longLength").value = DEFAULTS.long;
    $("longInterval").value = DEFAULTS.interval;
    $("autoBreaks").checked = DEFAULTS.autoBreaks;
    $("autoFocus").checked = DEFAULTS.autoFocus;
    $("soundToggle").checked = DEFAULTS.sound;
    $("notifyToggle").checked = false;
    const note = $("settingsNote");
    note.textContent = "Defaults loaded. Choose Save settings to apply them.";
    note.hidden = false;
  });

  $("settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = $("settingsNote");
    note.hidden = true;

    const focus = clampInt($("focusLength").value, 1, 120, DEFAULTS.focus);
    const short = clampInt($("shortLength").value, 1, 60, DEFAULTS.short);
    const long = clampInt($("longLength").value, 1, 90, DEFAULTS.long);
    const interval = clampInt($("longInterval").value, 2, 10, DEFAULTS.interval);

    let notifications = $("notifyToggle").checked;
    if (notifications && !("Notification" in window)) {
      notifications = false;
      note.textContent = "This browser does not support desktop notifications.";
      note.hidden = false;
    }
    if (notifications && Notification.permission === "default") {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          notifications = false;
          note.textContent = "Notification permission was not granted. You can still use sounds and toasts.";
          note.hidden = false;
        }
      } catch (err) {
        notifications = false;
      }
    }
    if (notifications && Notification.permission === "denied") {
      notifications = false;
      note.textContent = "Notifications are blocked in this browser. Enable them in site settings to use this.";
      note.hidden = false;
    }

    state.settings = {
      focus,
      short,
      long,
      interval,
      autoBreaks: $("autoBreaks").checked,
      autoFocus: $("autoFocus").checked,
      sound: $("soundToggle").checked,
      notifications,
    };

    if (!timer.running) {
      timer.total = duration(timer.mode);
      timer.remaining = timer.total;
    }

    saveState();
    renderAll();
    if (note.hidden) closeSettings();
    toast("Settings saved");
  });

  /* ---------- Theme ---------- */

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    const isLight = state.theme === "light";
    const toggle = $("themeToggle");
    toggle.setAttribute("aria-pressed", String(isLight));
    toggle.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", isLight ? "#f8f4ed" : "#0b0a15");
  }

  $("themeToggle").addEventListener("click", () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    applyTheme();
    saveState();
  });

  /* ---------- Sound & notifications ---------- */

  function ensureAudio() {
    if (!state.settings.sound) return;
    try {
      if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        audioCtx = new AudioContext();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (err) {
      /* audio is optional */
    }
  }

  function playChime() {
    if (!state.settings.sound || !audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      [523.25, 659.25, 783.99].forEach((frequency, index) => {
        const oscillator = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        const start = now + index * 0.13;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
        oscillator.connect(gain);
        gain.connect(audioCtx.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.65);
      });
    } catch (err) {
      /* audio is optional */
    }
  }

  function notify(title, body) {
    if (!state.settings.notifications) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification(title, { body, icon: "icons/icon-192.png", tag: "focusflow" });
    } catch (err) {
      /* notifications are optional */
    }
  }

  /* ---------- Events ---------- */

  $("startBtn").addEventListener("click", toggleTimer);
  $("resetBtn").addEventListener("click", resetTimer);
  $("skipBtn").addEventListener("click", skipSession);

  document.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  $("addTaskForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("taskInput");
    if (!input.value.trim()) {
      input.focus();
      return;
    }
    addTask(input.value);
    input.value = "";
    input.focus();
  });

  $("taskList").addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    const item = action.closest(".task-item");
    if (!item) return;
    const taskId = item.dataset.id;
    const type = action.dataset.action;
    if (type === "toggle") toggleTask(taskId);
    else if (type === "delete") removeTask(taskId);
    else if (type === "select") selectTask(taskId);
  });

  $("taskList").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const main = event.target.closest(".task-main");
    if (!main) return;
    event.preventDefault();
    const item = main.closest(".task-item");
    if (item) selectTask(item.dataset.id);
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (settingsModal.open) return;
    if (event.code === "Space") {
      event.preventDefault();
      toggleTimer();
    } else if (event.key.toLowerCase() === "r" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      resetTimer();
    }
  });

  /* ---------- Toast ---------- */

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2400);
  }

  /* ---------- Init ---------- */

  const hadData = loadState();
  state.settings.focus = clampInt(state.settings.focus, 1, 120, DEFAULTS.focus);
  state.settings.short = clampInt(state.settings.short, 1, 60, DEFAULTS.short);
  state.settings.long = clampInt(state.settings.long, 1, 90, DEFAULTS.long);
  state.settings.interval = clampInt(state.settings.interval, 2, 10, DEFAULTS.interval);

  if (!hadData || !restoredTimer) {
    timer.total = duration(timer.mode);
    timer.remaining = timer.total;
  }

  applyTheme();
  $("todayLabel").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  let expired = false;
  if (timer.running && timer.endAt) {
    const remaining = Math.ceil((timer.endAt - Date.now()) / 1000);
    if (remaining > 0) {
      timer.remaining = Math.min(timer.total, remaining);
      startTicker();
    } else {
      timer.running = false;
      timer.endAt = null;
      timer.remaining = 0;
      expired = true;
    }
  } else {
    timer.running = false;
    timer.endAt = null;
  }

  renderAll();
  if (expired) completeSession();
  if (!hadData) saveState();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
