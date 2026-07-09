(function(){
  "use strict";

  // ---------- config ----------
  var config = {
    padL: "ShiftLeft",
    padR: "ShiftRight",
    inspectionSeconds: 15
  };
  var PENALTY_WINDOW_MS = 2000; // +2 penalty zone after inspection ends
  var DNF_AFTER_MS = 4000;      // grace after inspection ends before auto-DNF

  // Extra keys that can stop a running solve besides Space — these sit
  // right around the space bar (B/N/M) so a stray finger still lands a
  // stop even if it misses the space bar itself. Only active while SOLVING.
  var EXTRA_STOP_KEYS = ["KeyB", "KeyN", "KeyM"];

  // ---------- state ----------
  var STATE = { IDLE:"idle", INSPECTION:"inspection", ARMED:"armed", SOLVING:"solving" };
  var state = STATE.IDLE;

  var heldKeys = new Set();
  var inspectionStart = 0;
  var inspectionInterval = null;
  var solveStart = 0;
  var solveRAF = null;
  var pendingPenalty = null; // null | "+2" | "DNF"

  var panelCollapsed = false;
  var padsHidden = false;

  // stack of past scrambles so the "previous scramble" button can step back
  var scrambleHistory = [];
  var SCRAMBLE_HISTORY_LIMIT = 30;

  // ---------- sessions ----------
  // Each session keeps its own solve log + id counter, so switching
  // sessions never mixes solves together. `solves` / `solveIdCounter`
  // below always point at the *active* session's data via helpers.
  var sessions = []; // {id, name, solves:[...], solveIdCounter}
  var sessionIdCounter = 0;
  var activeSessionId = null;
  var solves = []; // always a reference to the active session's solves array

  function nextSolveId(){
    return ++(getActiveSession().solveIdCounter);
  }

  function getActiveSession(){
    for (var i=0;i<sessions.length;i++){
      if (sessions[i].id === activeSessionId) return sessions[i];
    }
    return sessions[0];
  }
  function createSession(name){
    var s = { id: ++sessionIdCounter, name: name || ("Session " + sessions.length), solves: [], solveIdCounter: 0 };
    sessions.push(s);
    return s;
  }

  // ---------- persistence (localStorage) ----------
  // Keeps the session (solves, current scramble, keybinds, inspection time,
  // panel state) across tab closes/reloads. Saved as one JSON blob so a
  // single read/write covers everything; falls back gracefully if
  // localStorage is unavailable (e.g. private browsing) or the saved data
  // is corrupt/from an older version.
  var STORAGE_KEY = "cubeTimerNiDal.v2";
  var STORAGE_KEY_LEGACY = "cubeTimerNiDal.v1"; // old single-session format

  function saveState(){
    try{
      var payload = {
        config: config,
        sessions: sessions,
        sessionIdCounter: sessionIdCounter,
        activeSessionId: activeSessionId,
        panelCollapsed: panelCollapsed,
        padsHidden: padsHidden,
        scramble: scrambleTextEl ? scrambleTextEl.textContent : null,
        scrambleHistory: scrambleHistory
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }catch(err){
      // storage unavailable or full — fail silently, timer still works
    }
  }

  function loadState(){
    var raw;
    try{
      raw = localStorage.getItem(STORAGE_KEY);
    }catch(err){
      return null;
    }
    if (!raw){
      return loadLegacyState();
    }
    try{
      var data = JSON.parse(raw);
      applyConfig(data.config);
      if (Array.isArray(data.sessions) && data.sessions.length){
        sessions = data.sessions.map(function(s){
          return {
            id: s.id,
            name: s.name || "Session",
            solves: Array.isArray(s.solves) ? s.solves : [],
            solveIdCounter: typeof s.solveIdCounter === "number" ? s.solveIdCounter : 0
          };
        });
        sessionIdCounter = sessions.reduce(function(max, s){
          return s.id > max ? s.id : max;
        }, data.sessionIdCounter || 0);
        activeSessionId = sessions.some(function(s){ return s.id === data.activeSessionId; })
          ? data.activeSessionId
          : sessions[0].id;
      } else {
        var s0 = createSession("Session 1");
        activeSessionId = s0.id;
      }
      solves = getActiveSession().solves;
      panelCollapsed = !!data.panelCollapsed;
      padsHidden = !!data.padsHidden;
      scrambleHistory = Array.isArray(data.scrambleHistory) ? data.scrambleHistory : [];
      return data;
    }catch(err){
      return null;
    }
  }

  // migrate the older single-session save format into one session
  function loadLegacyState(){
    var raw;
    try{
      raw = localStorage.getItem(STORAGE_KEY_LEGACY);
    }catch(err){
      return null;
    }
    if (!raw) return null;
    try{
      var data = JSON.parse(raw);
      applyConfig(data.config);
      var legacySolves = Array.isArray(data.solves) ? data.solves : [];
      var s = createSession("Session 1");
      s.solves = legacySolves;
      s.solveIdCounter = legacySolves.reduce(function(max, sv){
        return typeof sv.id === "number" && sv.id > max ? sv.id : max;
      }, data.solveIdCounter || 0);
      activeSessionId = s.id;
      solves = s.solves;
      panelCollapsed = !!data.panelCollapsed;
      return data;
    }catch(err){
      return null;
    }
  }

  function applyConfig(c){
    if (c && typeof c === "object"){
      if (c.padL) config.padL = c.padL;
      if (c.padR) config.padR = c.padR;
      if (typeof c.inspectionSeconds === "number") config.inspectionSeconds = c.inspectionSeconds;
    }
  }

  // ---------- dom ----------
  var displayEl = document.getElementById("display");
  var hintEl = document.getElementById("hint");
  var panelEl = document.getElementById("panel");
  var toggleLink = document.getElementById("toggleLink");
  var avgLine = document.getElementById("avgLine");
  var solveRows = document.getElementById("solveRows");
  var statBest = document.getElementById("statBest");
  var statAo12 = document.getElementById("statAo12");
  var statMean = document.getElementById("statMean");
  var clearBtn = document.getElementById("clearBtn");

  var scrambleTextEl = document.getElementById("scrambleText");
  var prevScrambleBtn = document.getElementById("prevScrambleBtn");

  var settingsBtn = document.getElementById("settingsBtn");
  var modalBackdrop = document.getElementById("modalBackdrop");
  var closeModal = document.getElementById("closeModal");
  var rebindL = document.getElementById("rebindL");
  var rebindR = document.getElementById("rebindR");
  var inspVal = document.getElementById("inspVal");
  var inspMinus = document.getElementById("inspMinus");
  var inspPlus = document.getElementById("inspPlus");

  var scrambleModalBackdrop = document.getElementById("scrambleModalBackdrop");
  var scrambleModalTitle = document.getElementById("scrambleModalTitle");
  var scrambleModalText = document.getElementById("scrambleModalText");
  var scrambleModalClose = document.getElementById("scrambleModalClose");

  var padLBtn = document.getElementById("padLBtn");
  var padRBtn = document.getElementById("padRBtn");
  var padLBtnKey = document.getElementById("padLBtnKey");
  var padRBtnKey = document.getElementById("padRBtnKey");
  var spaceBtn = document.getElementById("spaceBtn");
  var padsRow = document.getElementById("padsRow");
  var padsToggleLink = document.getElementById("padsToggleLink");

  var sessionTabsScroll = document.getElementById("sessionTabsScroll");
  var sessionAddBtn = document.getElementById("sessionAddBtn");

  // ---------- key label helper ----------
  function keyLabel(code){
    var map = {
      ShiftLeft:"Shift L", ShiftRight:"Shift R",
      ControlLeft:"Ctrl L", ControlRight:"Ctrl R",
      AltLeft:"Alt L", AltRight:"Alt R",
      Space:"Space", Enter:"Enter", Tab:"Tab",
      ArrowLeft:"←", ArrowRight:"→", ArrowUp:"↑", ArrowDown:"↓"
    };
    if (map[code]) return map[code];
    if (code.indexOf("Key")===0) return code.slice(3);
    if (code.indexOf("Digit")===0) return code.slice(5);
    return code;
  }

  function refreshPadButtonLabels(){
    padLBtnKey.textContent = keyLabel(config.padL);
    padRBtnKey.textContent = keyLabel(config.padR);
  }

  // ---------- scramble generator (3x3, WCA-notation random-move) ----------
  // Note: TNoodle's real scrambler is a Java desktop tool and can't run
  // inside a static web page, so this generates scrambles client-side in
  // the browser using the same move notation (U D L R F B, with ' and 2
  // modifiers). It avoids repeating a face and avoids more than two
  // consecutive moves on the same axis, matching standard scramble rules.
  var SCRAMBLE_LEN = 20;
  var FACES = ["U", "D", "L", "R", "F", "B"];
  var AXIS = { U: 0, D: 0, L: 1, R: 1, F: 2, B: 2 };
  var MODS = ["", "'", "2"];

  function generateScramble(length){
    length = length || SCRAMBLE_LEN;
    var moves = [];
    var lastFace = null, lastAxis = null, axisStreak = 0;
    for (var i = 0; i < length; i++){
      var candidates = FACES.filter(function(f){
        if (f === lastFace) return false;
        if (AXIS[f] === lastAxis && axisStreak >= 2) return false;
        return true;
      });
      var face = candidates[Math.floor(Math.random() * candidates.length)];
      var mod = MODS[Math.floor(Math.random() * MODS.length)];
      moves.push(face + mod);
      axisStreak = (AXIS[face] === lastAxis) ? axisStreak + 1 : 1;
      lastAxis = AXIS[face];
      lastFace = face;
    }
    return moves.join(" ");
  }

  function newScramble(){
    var current = scrambleTextEl.textContent;
    if (current && current !== "generating…"){
      scrambleHistory.push(current);
      if (scrambleHistory.length > SCRAMBLE_HISTORY_LIMIT) scrambleHistory.shift();
    }
    scrambleTextEl.textContent = generateScramble();
    updatePrevScrambleBtn();
    saveState();
  }

  function updatePrevScrambleBtn(){
    if (!prevScrambleBtn) return;
    prevScrambleBtn.disabled = !scrambleHistory.length;
  }

  // steps back to the scramble that was showing before the current one —
  // only while idle, so it can't be used to swap the scramble mid-solve
  function goToPreviousScramble(){
    if (!scrambleHistory.length) return;
    if (state !== STATE.IDLE) return;
    scrambleTextEl.textContent = scrambleHistory.pop();
    updatePrevScrambleBtn();
    saveState();
  }

  // ---------- formatting ----------
  function formatMs(ms){
    var totalCs = Math.floor(ms/10);
    var cs = totalCs % 100;
    var totalSec = Math.floor(totalCs/100);
    var sec = totalSec % 60;
    var min = Math.floor(totalSec/60);
    var csStr = (cs<10?"0":"")+cs;
    if (min>0){
      var secStr = (sec<10?"0":"")+sec;
      return min+":"+secStr+"."+csStr;
    }
    return sec+"."+csStr;
  }

  // ---------- display state helper ----------
  function setDisplayClass(cls){
    displayEl.className = "display " + cls;
  }
  // mobile uses a press-and-hold gesture on the space button instead of the
  // two-hand pad-hold mechanic, so its labels/behavior branch on viewport
  var mobileMQ = window.matchMedia("(max-width:768px)");
  function isMobileMode(){ return mobileMQ.matches; }

  function updateSpaceBtn(){
    spaceBtn.className = "space-btn";
    var mobile = isMobileMode();
    if (state === STATE.SOLVING){
      spaceBtn.textContent = mobile ? "TAP TO STOP" : "STOP";
      spaceBtn.classList.add("state-solving");
    } else if (state === STATE.ARMED){
      spaceBtn.textContent = mobile ? "RELEASE TO START" : "CANCEL";
      spaceBtn.classList.add("state-armed");
    } else if (state === STATE.INSPECTION){
      spaceBtn.textContent = mobile ? "KEEP HOLDING…" : "CANCEL";
      spaceBtn.classList.add("state-inspection");
    } else {
      spaceBtn.textContent = mobile ? "HOLD TO START" : "TAP TO START";
    }
  }

  // ---------- reset to idle ----------
  function goIdle(msg){
    state = STATE.IDLE;
    clearInterval(inspectionInterval);
    cancelAnimationFrame(solveRAF);
    pendingPenalty = null;
    setDisplayClass("state-idle");
    if (solves.length){
      var last = solves[solves.length-1];
      displayEl.textContent = last.dnf ? "DNF" : formatMs(last.ms);
      setDisplayClass(last.dnf ? "state-dnf" : "state-idle");
    } else {
      displayEl.textContent = "0.00";
    }
    hintEl.innerHTML = msg || 'press <span class="tag">SPACE</span> to start inspection';
    updateSpaceBtn();
  }

  // ---------- inspection ----------
  function startInspection(){
    if (state !== STATE.IDLE) return;
    state = STATE.INSPECTION;
    inspectionStart = performance.now();
    setDisplayClass("state-inspection");
    updateInspection();
    inspectionInterval = setInterval(updateInspection, 50);
    hintEl.innerHTML = 'hold <span class="tag">' + keyLabel(config.padL) + '</span> + <span class="tag">' + keyLabel(config.padR) + '</span>, then release to start';
    updateSpaceBtn();
    hintEl.innerHTML = 'press SPACE to stop';
  }

  function updateInspection(){
    var elapsed = performance.now() - inspectionStart;
    var limitMs = config.inspectionSeconds*1000;
    var remaining = limitMs - elapsed;

    if (elapsed <= limitMs){
      displayEl.textContent = Math.max(0, Math.ceil(remaining/1000));
      pendingPenalty = null;
    } else if (elapsed <= limitMs + PENALTY_WINDOW_MS){
      displayEl.textContent = "+2";
      pendingPenalty = "+2";
    } else if (elapsed <= limitMs + DNF_AFTER_MS){
      displayEl.textContent = "DNF";
      pendingPenalty = "DNF";
    } else {
      solves.push({id: nextSolveId(), ms:0, penalty:null, dnf:true, scramble: scrambleTextEl.textContent});
      renderSolves();
      setDisplayClass("state-dnf");
      newScramble();
      goIdle('inspection timed out — press SPACE to try again');
    }
  }

  // ---------- armed (press-and-hold, release to start) ----------
  function checkArm(){
    if (state !== STATE.INSPECTION) return;
    if (heldKeys.has(config.padL) && heldKeys.has(config.padR)){
      state = STATE.ARMED;
      setDisplayClass("state-armed");
      // hintEl.innerHTML = 'release to <span class="tag">start</span>';
      updateSpaceBtn();
    }
  }
  function breakArm(){
    if (state === STATE.ARMED){
      // one of the two pad keys was just released while armed -> start immediately
      startSolve();
      return;
    }
    if (state === STATE.INSPECTION){
      // was never fully armed (only one key was held) — stay in inspection
      hintEl.innerHTML = 'hold <span class="tag">' + keyLabel(config.padL) + '</span> + <span class="tag">' + keyLabel(config.padR) + '</span>, then release to start';
      updateSpaceBtn();
    }
  }

  // ---------- solving ----------
  function startSolve(){
    clearInterval(inspectionInterval);
    var appliedPenalty = (pendingPenalty === "+2") ? "+2" : null;
    var wasDnfZone = (pendingPenalty === "DNF");
    pendingPenalty = null;
    state = STATE.SOLVING;
    solveStart = performance.now();
    window.__forceDnf = wasDnfZone;
    window.__penalty = appliedPenalty;
    setDisplayClass("state-solving");
    // hintEl.innerHTML = 'press <span class="tag">SPACE</span> (or B / N / M) to stop';
    updateSpaceBtn();
    tickSolve();
  }
  function tickSolve(){
    var elapsed = performance.now() - solveStart;
    displayEl.textContent = formatMs(elapsed);
    solveRAF = requestAnimationFrame(tickSolve);
  }
  function stopSolve(){
    cancelAnimationFrame(solveRAF);
    var elapsed = performance.now() - solveStart;
    var dnf = !!window.__forceDnf;
    var penalty = window.__penalty || null;
    var finalMs = elapsed + (penalty === "+2" ? 2000 : 0);
    solves.push({id: nextSolveId(), ms: dnf ? 0 : finalMs, penalty: penalty, dnf: dnf, scramble: scrambleTextEl.textContent});
    renderSolves();
    setDisplayClass(dnf ? "state-dnf" : "state-idle");
    var resultText = dnf ? "DNF" : formatMs(finalMs) + (penalty ? " (+2)" : "");
    newScramble();
    goIdle('</span> press SPACE to start inspection');
  }

  // ---------- space handling ----------
  function onSpace(){
    if (state === STATE.IDLE){
      startInspection();
    } else if (state === STATE.INSPECTION || state === STATE.ARMED){
      goIdle('inspection cancelled — press <span class="tag">SPACE</span> to start again');
    } else if (state === STATE.SOLVING){
      stopSolve();
    }
  }

  // ---------- keyboard listeners ----------
  var rebindTarget = null; // "L" | "R" | null

  window.addEventListener("keydown", function(e){
    if (rebindTarget){
      if (e.code === "Escape"){ cancelRebind(); return; }
      if (e.code === "Space") return;
      if (EXTRA_STOP_KEYS.indexOf(e.code) !== -1) return; // reserved for stopping
      var other = rebindTarget === "L" ? config.padR : config.padL;
      if (e.code === other) return;
      if (rebindTarget === "L") config.padL = e.code; else config.padR = e.code;
      finishRebind();
      e.preventDefault();
      return;
    }

    if (e.code === "Space"){
      e.preventDefault();
      if (!e.repeat) onSpace();
      return;
    }

    if (state === STATE.SOLVING && EXTRA_STOP_KEYS.indexOf(e.code) !== -1){
      e.preventDefault();
      if (!e.repeat) stopSolve();
      return;
    }

    if (e.repeat) return;
    if (e.code === config.padL || e.code === config.padR){
      e.preventDefault();
      heldKeys.add(e.code);
      checkArm();
    }
  });

  window.addEventListener("keyup", function(e){
    if (e.code === config.padL || e.code === config.padR){
      heldKeys.delete(e.code);
      breakArm();
    }
  });

  // ---------- on-screen touch controls (mobile/no-keyboard support) ----------
  // Pointer events unify mouse + touch/stylus in one listener set, so the
  // same pads work whether someone taps on a phone or clicks with a mouse.
  // touch-action:none in CSS stops the browser from trying to scroll/zoom
  // while a pad is held down.
  function bindPadPointer(el, getCode){
    function down(e){
      e.preventDefault();
      try{ el.setPointerCapture(e.pointerId); }catch(err){}
      heldKeys.add(getCode());
      el.classList.add("active");
      checkArm();
    }
    function up(e){
      heldKeys.delete(getCode());
      el.classList.remove("active");
      breakArm();
    }
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
  }
  bindPadPointer(padLBtn, function(){ return config.padL; });
  bindPadPointer(padRBtn, function(){ return config.padR; });

  // desktop keeps the original tap-to-toggle behavior; mobile gets a
  // press-and-hold gesture instead (press starts inspection and arms
  // immediately, release starts the solve, a tap while solving stops it)
  function spacePointerDown(e){
    if (!isMobileMode()){
      onSpace();
      return;
    }
    e.preventDefault();
    if (state === STATE.IDLE){
      startInspection();
      heldKeys.add(config.padL);
      heldKeys.add(config.padR);
      checkArm();
    } else if (state === STATE.SOLVING){
      stopSolve();
    }
  }
  function spacePointerUp(e){
    if (!isMobileMode()) return;
    if (state === STATE.ARMED || state === STATE.INSPECTION){
      heldKeys.delete(config.padL);
      heldKeys.delete(config.padR);
      breakArm();
    }
  }
  spaceBtn.addEventListener("pointerdown", spacePointerDown);
  spaceBtn.addEventListener("pointerup", spacePointerUp);
  spaceBtn.addEventListener("pointercancel", spacePointerUp);

  // ---------- stats ----------
  function validTimes(){
    return solves.filter(function(s){ return !s.dnf; }).map(function(s){ return s.ms; });
  }
  function average(arr){
    if (!arr.length) return null;
    var sum = arr.reduce(function(a,b){return a+b;},0);
    return sum/arr.length;
  }
  function aoN(n){
    if (solves.length < n) return {text:"–"};
    var lastN = solves.slice(-n);
    var dnfCount = lastN.filter(function(s){return s.dnf;}).length;
    if ((n===5 || n===12) && dnfCount>=2) return {text:"DNF"};
    var times = lastN.map(function(s){ return s.dnf ? Infinity : s.ms; });
    var sorted = times.slice().sort(function(a,b){return a-b;});
    var trimmed = sorted.slice(1, sorted.length-1);
    if (trimmed.some(function(t){return t===Infinity;})) return {text:"DNF"};
    return {text: formatMs(average(trimmed))};
  }
  function renderSolves(){
    var vt = validTimes();
    statBest.textContent = vt.length ? formatMs(Math.min.apply(null, vt)) : "–";
    statMean.textContent = vt.length ? formatMs(average(vt)) : "–";
    statAo12.textContent = aoN(12).text;
    avgLine.textContent = "AVERAGE OF 5: " + aoN(5).text;

    solveRows.innerHTML = "";
    if (!solves.length){
      solveRows.innerHTML = '<div class="solve-row no-click"><span class="idx">no solves yet</span></div>';
      renderSessionTabs();
      saveState();
      return;
    }
    // show every solve in this session — the wrapping .solve-rows-scroll
    // container caps the visible height to ~5 rows and scrolls beyond that
    solves.forEach(function(s, i){
      var solveNumber = i + 1;
      var row = document.createElement("div");
      row.className = "solve-row" + (s.dnf ? " dnf" : "");
      row.title = "click to view scramble";

      var idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = "SOLVE " + solveNumber + ":";

      var val = document.createElement("span");
      val.className = "solve-val";
      val.textContent = s.dnf ? "DNF" : formatMs(s.ms) + (s.penalty ? " (+2)" : "");

      var del = document.createElement("button");
      del.className = "solve-del";
      del.type = "button";
      del.textContent = "\u00D7";
      del.title = "delete this solve";
      del.setAttribute("aria-label", "delete solve " + solveNumber);
      del.addEventListener("click", function(e){
        e.stopPropagation();
        deleteSolveById(s.id);
      });

      row.addEventListener("click", function(){
        openScrambleModal(s, solveNumber);
      });

      row.appendChild(idx);
      row.appendChild(val);
      row.appendChild(del);
      solveRows.appendChild(row);
    });
    renderSessionTabs();
    saveState();
  }

  // ---------- scramble-view modal ----------
  function openScrambleModal(solve, solveNumber){
    scrambleModalTitle.textContent = "SOLVE #" + solveNumber + (solve.dnf ? " — DNF" : "");
    scrambleModalText.textContent = solve.scramble || "scramble not recorded for this solve";
    scrambleModalBackdrop.classList.add("open");
  }
  function closeScrambleModal(){
    scrambleModalBackdrop.classList.remove("open");
  }
  prevScrambleBtn.addEventListener("click", goToPreviousScramble);

  scrambleModalClose.addEventListener("click", closeScrambleModal);
  scrambleModalBackdrop.addEventListener("click", function(e){
    if (e.target === scrambleModalBackdrop) closeScrambleModal();
  });

  // ---------- delete a single solve ----------
  // Removes exactly one solve by its stable id (not by array position), so
  // deleting one solve always affects that solve only, even if the list has
  // shifted since it was rendered.
  function deleteSolveById(id){
    var i = solves.findIndex(function(s){ return s.id === id; });
    if (i === -1) return;
    solves.splice(i, 1);
    renderSolves();
  }

  // ---------- session tabs ----------
  function renderSessionTabs(){
    sessionTabsScroll.innerHTML = "";
    sessions.forEach(function(s){
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "session-tab" + (s.id === activeSessionId ? " active" : "");
      tab.title = s.name;

      var label = document.createElement("span");
      label.textContent = s.name + " (" + s.solves.length + ")";
      tab.appendChild(label);

      if (sessions.length > 1){
        var del = document.createElement("span");
        del.className = "session-del";
        del.textContent = "\u00D7";
        del.title = "delete session";
        del.addEventListener("click", function(e){
          e.stopPropagation();
          deleteSession(s.id);
        });
        tab.appendChild(del);
      }

      tab.addEventListener("click", function(){ switchSession(s.id); });
      tab.addEventListener("dblclick", function(){ renameSession(s.id); });
      sessionTabsScroll.appendChild(tab);
    });
  }

  function switchSession(id){
    if (id === activeSessionId) return;
    // don't yank the active session out from under a running timer
    if (state !== STATE.IDLE) return;
    activeSessionId = id;
    solves = getActiveSession().solves;
    renderSolves();
  }

  function addSession(){
    var s = createSession("Session " + (sessions.length + 1));
    activeSessionId = s.id;
    solves = s.solves;
    renderSolves();
    // scroll the new tab into view
    requestAnimationFrame(function(){
      sessionTabsScroll.scrollLeft = sessionTabsScroll.scrollWidth;
    });
  }

  function deleteSession(id){
    if (sessions.length <= 1) return;
    var i = sessions.findIndex(function(s){ return s.id === id; });
    if (i === -1) return;
    sessions.splice(i, 1);
    if (activeSessionId === id){
      var next = sessions[Math.max(0, i - 1)];
      activeSessionId = next.id;
      solves = next.solves;
    }
    renderSolves();
  }

  function renameSession(id){
    var s = sessions.find(function(s){ return s.id === id; });
    if (!s) return;
    var name = window.prompt("Session name", s.name);
    if (name && name.trim()){
      s.name = name.trim().slice(0, 24);
      renderSessionTabs();
      saveState();
    }
  }

  sessionAddBtn.addEventListener("click", addSession);

  // ---------- pads visibility ----------
  function setPadsHidden(hidden){
    padsHidden = hidden;
    padsRow.classList.toggle("hidden", hidden);
    padsToggleLink.textContent = hidden ? "show pads" : "hide pads";
    saveState();
  }
  padsToggleLink.addEventListener("click", function(){ setPadsHidden(!padsHidden); });

  // ---------- panel collapse ----------
  function setPanelCollapsed(collapsed){
    panelCollapsed = collapsed;
    panelEl.classList.toggle("collapsed", collapsed);
    toggleLink.textContent = collapsed ? "show" : "hide";
    saveState();
  }
  toggleLink.addEventListener("click", function(){ setPanelCollapsed(!panelCollapsed); });

  // ---------- settings modal ----------
  settingsBtn.addEventListener("click", function(){ modalBackdrop.classList.add("open"); });
  closeModal.addEventListener("click", function(){ modalBackdrop.classList.remove("open"); cancelRebind(); });
  modalBackdrop.addEventListener("click", function(e){
    if (e.target === modalBackdrop){ modalBackdrop.classList.remove("open"); cancelRebind(); }
  });

  function startRebind(which){
    cancelRebind();
    rebindTarget = which;
    var btn = which === "L" ? rebindL : rebindR;
    btn.textContent = "press a key…";
    btn.classList.add("listening");
  }
  function finishRebind(){
    rebindL.textContent = keyLabel(config.padL);
    rebindR.textContent = keyLabel(config.padR);
    rebindL.classList.remove("listening");
    rebindR.classList.remove("listening");
    rebindTarget = null;
    refreshPadButtonLabels();
    saveState();
  }
  function cancelRebind(){
    rebindL.textContent = keyLabel(config.padL);
    rebindR.textContent = keyLabel(config.padR);
    rebindL.classList.remove("listening");
    rebindR.classList.remove("listening");
    rebindTarget = null;
  }
  rebindL.addEventListener("click", function(){ startRebind("L"); });
  rebindR.addEventListener("click", function(){ startRebind("R"); });

  inspMinus.addEventListener("click", function(){
    config.inspectionSeconds = Math.max(3, config.inspectionSeconds-1);
    inspVal.textContent = config.inspectionSeconds+"s";
    saveState();
  });
  inspPlus.addEventListener("click", function(){
    config.inspectionSeconds = Math.min(60, config.inspectionSeconds+1);
    inspVal.textContent = config.inspectionSeconds+"s";
    saveState();
  });

  // ---------- clear session ----------
  // Wipes all logged solves for the current session and resets the on-screen
  // display back to 0.00 (previously it only cleared the stats panel, leaving
  // the last solve's time still showing on the main display).
  clearBtn.addEventListener("click", function(){
    solves.length = 0;
    renderSolves();
    if (state === STATE.IDLE){
      setDisplayClass("state-idle");
      displayEl.textContent = "0.00";
      hintEl.innerHTML = 'press <span class="tag">SPACE</span> to start inspection';
    }
  });

  // ---------- init ----------
  var saved = loadState();

  if (!sessions.length){
    var firstSession = createSession("Session 1");
    activeSessionId = firstSession.id;
  }
  solves = getActiveSession().solves;

  // reflect any restored keybinds/inspection-time in the settings modal
  rebindL.textContent = keyLabel(config.padL);
  rebindR.textContent = keyLabel(config.padR);
  inspVal.textContent = config.inspectionSeconds + "s";
  refreshPadButtonLabels();

  renderSolves();

  // reuse the saved scramble (so it doesn't change on a plain reload);
  // only generate a fresh one if nothing was saved yet
  if (saved && typeof saved.scramble === "string" && saved.scramble){
    scrambleTextEl.textContent = saved.scramble;
  } else {
    newScramble();
  }
  updatePrevScrambleBtn();

  if (saved && saved.panelCollapsed){
    setPanelCollapsed(true);
  }
  if (padsHidden){
    setPadsHidden(true);
  }
  renderSessionTabs();

  goIdle();
  // ---------- cube net preview (renders the scramble as an unfolded cube, added feature) ----------
  var CUBE_COLORS = { U:"#f5f5f0", D:"#f7d417", F:"#3aae3a", B:"#2456e5", L:"#f0891c", R:"#e0342a" };
  var CUBE_FACE_ORDER = ["U","R","F","D","L","B"];
  var CUBE_FACE_NORMAL = { U:[0,1,0], D:[0,-1,0], F:[0,0,1], B:[0,0,-1], R:[1,0,0], L:[-1,0,0] };

  function cubeFacePoint(face, row, col){
    switch(face){
      case "F": return {x:col-1, y:1-row, z:1};
      case "B": return {x:1-col, y:1-row, z:-1};
      case "U": return {x:col-1, y:1, z:row-1};
      case "D": return {x:col-1, y:-1, z:1-row};
      case "R": return {x:1, y:1-row, z:1-col};
      case "L": return {x:-1, y:1-row, z:col-1};
    }
  }
  function cubeFaceRowCol(face, p){
    switch(face){
      case "F": return {row:1-p.y, col:p.x+1};
      case "B": return {row:1-p.y, col:1-p.x};
      case "U": return {row:p.z+1, col:p.x+1};
      case "D": return {row:1-p.z, col:p.x+1};
      case "R": return {row:1-p.y, col:1-p.z};
      case "L": return {row:1-p.y, col:p.z+1};
    }
  }
  function cubeNormalToFace(n){
    for (var i=0;i<CUBE_FACE_ORDER.length;i++){
      var f = CUBE_FACE_ORDER[i], fn = CUBE_FACE_NORMAL[f];
      if (fn[0]===n.x && fn[1]===n.y && fn[2]===n.z) return f;
    }
    return null;
  }
  var CUBE_MOVE_TRANSFORM = {
    U:function(p){ return {x:-p.z, y:p.y, z:p.x}; },
    D:function(p){ return {x:p.z, y:p.y, z:-p.x}; },
    F:function(p){ return {x:p.y, y:-p.x, z:p.z}; },
    B:function(p){ return {x:-p.y, y:p.x, z:p.z}; },
    R:function(p){ return {x:p.x, y:p.z, z:-p.y}; },
    L:function(p){ return {x:p.x, y:-p.z, z:p.y}; }
  };
  var CUBE_MOVE_AXIS_TEST = {
    U:function(p){ return p.y===1; },
    D:function(p){ return p.y===-1; },
    F:function(p){ return p.z===1; },
    B:function(p){ return p.z===-1; },
    R:function(p){ return p.x===1; },
    L:function(p){ return p.x===-1; }
  };

  function cubeTurnOnce(grids, face){
    var newGrids = {};
    CUBE_FACE_ORDER.forEach(function(f){ newGrids[f] = grids[f].slice(); });
    CUBE_FACE_ORDER.forEach(function(f){
      for (var row=0; row<3; row++){
        for (var col=0; col<3; col++){
          var p = cubeFacePoint(f, row, col);
          if (!CUBE_MOVE_AXIS_TEST[face](p)) continue;
          var n = CUBE_FACE_NORMAL[f];
          var newNormal = CUBE_MOVE_TRANSFORM[face]({x:n[0],y:n[1],z:n[2]});
          var newFace = cubeNormalToFace(newNormal);
          var newP = CUBE_MOVE_TRANSFORM[face](p);
          var rc = cubeFaceRowCol(newFace, newP);
          newGrids[newFace][rc.row*3+rc.col] = grids[f][row*3+col];
        }
      }
    });
    return newGrids;
  }

  function cubeApplyMove(grids, moveStr){
    var face = moveStr.charAt(0);
    var mod = moveStr.slice(1);
    var times = mod === "2" ? 2 : (mod === "'" ? 3 : 1);
    var g = grids;
    for (var i=0;i<times;i++){ g = cubeTurnOnce(g, face); }
    return g;
  }

  function cubeSolvedGrids(){
    var g = {};
    CUBE_FACE_ORDER.forEach(function(f){ g[f] = new Array(9).fill(CUBE_COLORS[f]); });
    return g;
  }

  function cubeGridsFromScramble(scrambleStr){
    var grids = cubeSolvedGrids();
    var moves = (scrambleStr || "").trim().split(/\s+/).filter(Boolean);
    moves.forEach(function(m){
      if (!/^[UDLRFB]['2]?$/.test(m)) return;
      grids = cubeApplyMove(grids, m);
    });
    return grids;
  }

  function cubeSvgFaceGroup(grid, x, y, cell, gap){
    var out = "";
    for (var row=0; row<3; row++){
      for (var col=0; col<3; col++){
        var cx = x + col*(cell+gap);
        var cy = y + row*(cell+gap);
        var color = grid[row*3+col];
        out += '<rect x="'+cx+'" y="'+cy+'" width="'+cell+'" height="'+cell+
               '" rx="2" fill="'+color+'" stroke="#0c0c0e" stroke-width="1.5"></rect>';
      }
    }
    return out;
  }

  function cubeBuildNetSVG(grids){
    var cell = 26, gap = 3;
    var faceW = cell*3 + gap*2;
    var faceGap = 10;
    var lX = 0, fX = faceW+faceGap, rX = 2*(faceW+faceGap), bX = 3*(faceW+faceGap);
    var uY = 0, midY = faceW+faceGap, dY = 2*(faceW+faceGap);
    var totalW = bX + faceW;
    var totalH = dY + faceW;
    var svg = '<svg viewBox="0 0 '+totalW+' '+totalH+'" xmlns="http://www.w3.org/2000/svg" width="100%" height="auto">';
    svg += cubeSvgFaceGroup(grids.U, fX, uY, cell, gap);
    svg += cubeSvgFaceGroup(grids.L, lX, midY, cell, gap);
    svg += cubeSvgFaceGroup(grids.F, fX, midY, cell, gap);
    svg += cubeSvgFaceGroup(grids.R, rX, midY, cell, gap);
    svg += cubeSvgFaceGroup(grids.B, bX, midY, cell, gap);
    svg += cubeSvgFaceGroup(grids.D, fX, dY, cell, gap);
    svg += '</svg>';
    return svg;
  }

  var cubeViewBtn = document.getElementById("cubeViewBtn");
  var cubeNetModalBackdrop = document.getElementById("cubeNetModalBackdrop");
  var cubeNetWrap = document.getElementById("cubeNetWrap");
  var cubeNetModalClose = document.getElementById("cubeNetModalClose");

  if (cubeViewBtn && cubeNetModalBackdrop && cubeNetWrap){
    cubeViewBtn.addEventListener("click", function(){
      var scrambleStr = scrambleTextEl ? scrambleTextEl.textContent : "";
      var grids = cubeGridsFromScramble(scrambleStr);
      cubeNetWrap.innerHTML = cubeBuildNetSVG(grids);
      cubeNetModalBackdrop.classList.add("open");
    });
  }
  if (cubeNetModalClose && cubeNetModalBackdrop){
    cubeNetModalClose.addEventListener("click", function(){
      cubeNetModalBackdrop.classList.remove("open");
    });
  }
  if (cubeNetModalBackdrop){
    cubeNetModalBackdrop.addEventListener("click", function(e){
      if (e.target === cubeNetModalBackdrop) cubeNetModalBackdrop.classList.remove("open");
    });
  }
})();
