const $ = (s) => document.querySelector(s);
const jobsTbody = $("#jobsTbody");
const rowTpl = $("#rowTpl");
const logModal = $("#logModal");
const logText = $("#logText");
const closeLogBtn = $("#closeLog");
let currentLogEventSource = null;

$("#btnStart").addEventListener("click", async () => {
  const input = $("#input").value.trim();
  if (!input) {
    alert("Pegá una URL o canal");
    return;
  }

  const cutMinutes = parseInt(document.getElementById("cutMin")?.value || "0", 10);
  const format = document.getElementById("format")?.value || null;

  const r = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, cutMinutes, format })
  });
  if (!r.ok) {
    const t = await r.text();
    alert("Error: " + t);
    return;
  }
  $("#input").value = "";
  if (document.getElementById("cutMin")) document.getElementById("cutMin").value = "";
  refresh();
});

closeLogBtn.addEventListener("click", () => {
  logModal.classList.add("hidden");
  if (currentLogEventSource) currentLogEventSource.close();
});

async function stopJob(id) {
  await fetch(`/api/jobs/${id}/stop`, { method: "POST" });
  setTimeout(refresh, 500);
}

function elapsedFmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

function renderJobs(arr) {
  jobsTbody.innerHTML = "";
  for (const j of arr) {
    const row = rowTpl.content.cloneNode(true);
    row.querySelector(".id").textContent = j.id;
    row.querySelector(".channel").textContent = j.channel;
    const st = row.querySelector(".state");
    st.textContent = j.state;
    st.classList.add(j.state);
    row.querySelector(".elapsed").textContent = elapsedFmt(j.elapsedSec);
    row.querySelector(".size").textContent = j.sizeHuman;
    // NUEVO: velocidad
    if (row.querySelector(".speed")) {
      row.querySelector(".speed").textContent = (j.speedMBs || 0).toFixed(2) + " MB/s";
    }
    row.querySelector(".bitrate").textContent = (j.bitrateKbps || 0) + " kbps";
    row.querySelector(".file").textContent = j.currentFile || (j.outputFile || "");

    const actions = row.querySelector(".actions");
    const logBtn = document.createElement("button");
    logBtn.textContent = "Ver logs";
    logBtn.onclick = () => openLogs(j.id);
    actions.appendChild(logBtn);

    if (j.state === "RECORDING" || j.state === "STARTING") {
      const stopBtn = document.createElement("button");
      stopBtn.textContent = "Detener";
      stopBtn.className = "danger";
      stopBtn.onclick = () => stopJob(j.id);
      actions.appendChild(stopBtn);
    }

    if (j.state === "FINISHED" && j.outputFile) {
      const a = document.createElement("a");
      const pieces = j.outputFile.split(/[/\\]/);
      const fname = pieces[pieces.length - 1];
      a.href = `/downloads/${encodeURIComponent(j.channel)}/${encodeURIComponent(fname)}`;
      a.textContent = "Descargar MP4";
      a.className = "button";
      a.setAttribute("download", fname);
      actions.appendChild(a);
    }

    jobsTbody.appendChild(row);
  }
}

async function refresh() {
  const r = await fetch("/api/jobs");
  const arr = await r.json();
  renderJobs(arr);

  const channels = [...new Set(arr.map((j) => j.channel))];
  renderFiles(channels);
}

async function renderFiles(channels) {
  const wrap = $("#files");
  wrap.innerHTML = "";
  for (const ch of channels) {
    const res = await fetch(`/api/files/${encodeURIComponent(ch)}`);
    const files = await res.json();
    if (!files || !files.length) continue;
    for (const f of files) {
      const card = document.createElement("div");
      card.className = "file-card";
      card.innerHTML = `
        <div class="muted">Canal: <b>${ch}</b></div>
        <div class="name">${f.name}</div>
        <div><a href="${f.url}" download>Descargar</a></div>
      `;
      wrap.appendChild(card);
    }
  }
}

function openLogs(id) {
  if (currentLogEventSource) currentLogEventSource.close();
  logText.textContent = "";
  logModal.classList.remove("hidden");
  currentLogEventSource = new EventSource(`/api/logs/${id}`);
  currentLogEventSource.onmessage = (ev) => {
    logText.textContent += ev.data + "\n";
    logText.scrollTop = logText.scrollHeight;
  };
  currentLogEventSource.onerror = () => {};
}

setInterval(refresh, 1500);
refresh();
