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

  var solves = []; // {id, ms, penalty:null|"+2", dnf:bool, scramble:string}
  var solveIdCounter = 0;
  var panelCollapsed = false;

  // ---------- persistence (localStorage) ----------
  // Keeps the session (solves, current scramble, keybinds, inspection time,
  // panel state) across tab closes/reloads. Saved as one JSON blob so a
  // single read/write covers everything; falls back gracefully if
  // localStorage is unavailable (e.g. private browsing) or the saved data
  // is corrupt/from an older version.
  var STORAGE_KEY = "cubeTimerNiDal.v1";

  function saveState(){
    try{
      var payload = {
        config: config,
        solves: solves,
        solveIdCounter: solveIdCounter,
        panelCollapsed: panelCollapsed,
        scramble: scrambleTextEl ? scrambleTextEl.textContent : null
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
    if (!raw) return null;
    try{
      var data = JSON.parse(raw);
      if (data.config && typeof data.config === "object"){
        if (data.config.padL) config.padL = data.config.padL;
        if (data.config.padR) config.padR = data.config.padR;
        if (typeof data.config.inspectionSeconds === "number"){
          config.inspectionSeconds = data.config.inspectionSeconds;
        }
      }
      if (Array.isArray(data.solves)) solves = data.solves;
      solveIdCounter = solves.reduce(function(max, s){
        return typeof s.id === "number" && s.id > max ? s.id : max;
      }, data.solveIdCounter || 0);
      panelCollapsed = !!data.panelCollapsed;
      return data;
    }catch(err){
      return null;
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
    scrambleTextEl.textContent = generateScramble();
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
  function updateSpaceBtn(){
    spaceBtn.className = "space-btn";
    if (state === STATE.SOLVING){
      spaceBtn.textContent = "STOP";
      spaceBtn.classList.add("state-solving");
    } else if (state === STATE.ARMED){
      spaceBtn.textContent = "CANCEL";
      spaceBtn.classList.add("state-armed");
    } else if (state === STATE.INSPECTION){
      spaceBtn.textContent = "CANCEL";
      spaceBtn.classList.add("state-inspection");
    } else {
      spaceBtn.textContent = "TAP TO START";
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
      solves.push({id: ++solveIdCounter, ms:0, penalty:null, dnf:true, scramble: scrambleTextEl.textContent});
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
    solves.push({id: ++solveIdCounter, ms: dnf ? 0 : finalMs, penalty: penalty, dnf: dnf, scramble: scrambleTextEl.textContent});
    renderSolves();
    setDisplayClass(dnf ? "state-dnf" : "state-idle");
    var resultText = dnf ? "DNF" : formatMs(finalMs) + (penalty ? " (+2)" : "");
    newScramble();
    goIdle('</span> — press SPACE to start inspection');
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

  spaceBtn.addEventListener("click", function(){ onSpace(); });

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
      saveState();
      return;
    }
    var lastFive = solves.slice(-5);
    var startIdx = solves.length - lastFive.length;
    lastFive.forEach(function(s, i){
      var solveNumber = startIdx + i + 1;
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
    solves = [];
    renderSolves();
    if (state === STATE.IDLE){
      setDisplayClass("state-idle");
      displayEl.textContent = "0.00";
      hintEl.innerHTML = 'press <span class="tag">SPACE</span> to start inspection';
    }
  });

  // ---------- init ----------
  var saved = loadState();

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

  if (saved && saved.panelCollapsed){
    setPanelCollapsed(true);
  }

  goIdle();
})();
