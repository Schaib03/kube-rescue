import "./style.css";
import { endpointsFor, podsFor } from "./cluster/simulate";
import { LEVELS } from "./levels/levels";
import { Game, HELP_TEXT, type Line } from "./ui/game";
import { escapeHtml, highlight, inlineCode } from "./ui/highlight";
import { loadProgress, saveProgress, starsFor } from "./ui/progress";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const output = $<HTMLDivElement>("output");
const form = $<HTMLFormElement>("prompt");
const input = $<HTMLInputElement>("command");
const mission = $<HTMLElement>("mission");
const map = $<HTMLDivElement>("map");
const levelsNav = $<HTMLElement>("levels");
const winDialog = $<HTMLDialogElement>("win");

const game = new Game();
const progress = loadProgress();
const commandHistory: string[] = [];
let historyIndex = 0;

function print(lines: Line[]): void {
  for (const line of lines) {
    const div = document.createElement("div");
    div.className = `block ${line.kind}`;
    div.innerHTML = line.kind === "out" ? highlight(line.text) : line.kind === "cmd" ? escapeHtml(line.text) : inlineCode(line.text);
    output.appendChild(div);
  }
  output.scrollTop = output.scrollHeight;
}

function stars(count: number, total = 3): string {
  return Array.from({ length: total }, (_, i) => (i < count ? "★" : '<span class="off">★</span>')).join("");
}

function renderLevels(): void {
  levelsNav.innerHTML = "";
  LEVELS.forEach((level, i) => {
    const button = document.createElement("button");
    button.textContent = String(i + 1);
    button.title = `${level.title}${progress[level.id] ? ` · ${"★".repeat(progress[level.id])}` : ""}`;
    if (progress[level.id]) button.classList.add("done");
    if (i === game.index) button.classList.add("current");
    button.addEventListener("click", () => start(i));
    levelsNav.appendChild(button);
  });
}

function renderMission(): void {
  const level = game.level;
  const done = game.solved;
  mission.innerHTML = `
    <p class="eyebrow">INCIDENT ${game.index + 1} / ${LEVELS.length}</p>
    <h3>${escapeHtml(level.title)}</h3>
    <p class="ticket">${inlineCode(level.ticket)}</p>
    <div class="goal ${done ? "done" : ""}"><span class="box"></span><span>${inlineCode(level.goal)}</span></div>
    <div class="meta"><span>commands: ${game.commands} · par ${level.par}</span><span>hints: ${game.hints}/3</span></div>
    <div class="buttons">
      <button type="button" class="ghost" data-action="hint">Hint</button>
      <button type="button" class="ghost" data-action="reset">Reset</button>
    </div>`;
  mission.querySelector('[data-action="hint"]')?.addEventListener("click", () => submit("hint"));
  mission.querySelector('[data-action="reset"]')?.addEventListener("click", () => submit("reset"));
}

function podClass(status: string, ready: boolean): string {
  if (status === "ContainerCreating") return "new";
  if (status === "Running") return ready ? "ok" : "warn";
  if (status === "Pending") return "warn";
  return "bad";
}

function renderMap(): void {
  const now = Date.now();
  const c = game.cluster;
  const services = c.services
    .map((s) => {
      const { ready } = endpointsFor(c, s, now);
      const ok = ready.length > 0;
      return `<div class="svc"><span>svc/${escapeHtml(s.name)} <span class="muted">:${s.port}→${s.targetPort}</span></span>
        <span class="ep ${ok ? "ok" : "bad"}">${ok ? `${ready.length} endpoint${ready.length > 1 ? "s" : ""}` : "no endpoints"}</span></div>`;
    })
    .join("");
  const deployments = c.deployments
    .map((d) => {
      const pods = podsFor(c, d, now);
      const ready = pods.filter((p) => p.ready).length;
      const chips = pods
        .map((p) => `<span class="pod ${podClass(p.status, p.ready)}" title="${escapeHtml(p.name)}">${escapeHtml(p.status === "Running" && !p.ready ? "NotReady" : p.status)}</span>`)
        .join("");
      return `<div class="group"><div class="group-head"><span>deploy/${escapeHtml(d.name)}</span><span class="count">${ready}/${d.replicas} ready</span></div><div class="pods">${chips}</div></div>`;
    })
    .join("");
  map.innerHTML = services + deployments;
}

function render(): void {
  renderLevels();
  renderMission();
  renderMap();
}

function showWin(): void {
  const level = game.level;
  const earned = starsFor(game.commands, level.par, game.hints);
  progress[level.id] = Math.max(progress[level.id] ?? 0, earned);
  saveProgress(progress);
  $("win-title").textContent = level.title;
  $("win-stars").innerHTML = stars(earned);
  $("win-stats").textContent = `${game.commands} command${game.commands === 1 ? "" : "s"} · par ${level.par} · ${game.hints} hint${game.hints === 1 ? "" : "s"}`;
  $("win-lesson").innerHTML = inlineCode(level.lesson);
  const last = game.index === LEVELS.length - 1;
  $("win-next").textContent = last ? "See your score" : "Next incident";
  winDialog.showModal();
  render();
}

function showSummary(): void {
  const total = LEVELS.reduce((sum, l) => sum + (progress[l.id] ?? 0), 0);
  const solved = LEVELS.filter((l) => progress[l.id]).length;
  print([
    { kind: "ok", text: `All incidents handled: ${solved}/${LEVELS.length} solved, ${total}/${LEVELS.length * 3} stars.` },
    { kind: "sys", text: "Thanks for playing. Replay any incident from the numbers at the top to improve your score." },
  ]);
}

function start(index: number): void {
  game.load(index);
  commandHistory.length = 0;
  output.innerHTML = "";
  if (location.hash !== `#${index + 1}`) window.history.replaceState(null, "", `#${index + 1}`);
  print([
    { kind: "sys", text: `Incident ${index + 1}: ${game.level.title}` },
    { kind: "sys", text: "Type `kubectl get pods` to look around, `help` for game commands, `hint` if you are stuck." },
  ]);
  render();
  input.focus();
}

function submit(raw: string): void {
  const line = raw.trim();
  if (!line) return;
  print([{ kind: "cmd", text: line }]);
  commandHistory.push(line);
  historyIndex = commandHistory.length;
  const [word, arg] = line.split(/\s+/);

  switch (word) {
    case "help":
      print([{ kind: "sys", text: HELP_TEXT }]);
      break;
    case "clear":
      output.innerHTML = "";
      break;
    case "hint": {
      const hint = game.nextHint();
      print([hint ? { kind: "hint", text: `Hint ${game.hints}/3: ${hint}` } : { kind: "sys", text: "No more hints for this incident." }]);
      break;
    }
    case "reset":
      start(game.index);
      return;
    case "levels":
      print([
        {
          kind: "sys",
          text: LEVELS.map((l, i) => `${String(i + 1).padStart(2)}. ${l.title.padEnd(30)} ${"★".repeat(progress[l.id] ?? 0)}`).join("\n"),
        },
      ]);
      break;
    case "level":
      if (arg && Number(arg) >= 1 && Number(arg) <= LEVELS.length) start(Number(arg) - 1);
      else print([{ kind: "err", text: `usage: level 1-${LEVELS.length}` }]);
      return;
    case "next":
      start(Math.min(game.index + 1, LEVELS.length - 1));
      return;
    default:
      print(game.run(line));
  }
  render();
  checkWin();
}

function checkWin(): void {
  if (game.solved || !game.isSolved()) return;
  game.solved = true;
  print([{ kind: "ok", text: `✔ ${game.level.goal.replace(/`/g, "")}` }]);
  setTimeout(showWin, 450);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = input.value;
  input.value = "";
  submit(value);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp" && commandHistory.length) {
    historyIndex = Math.max(0, historyIndex - 1);
    input.value = commandHistory[historyIndex];
    event.preventDefault();
  } else if (event.key === "ArrowDown") {
    historyIndex = Math.min(commandHistory.length, historyIndex + 1);
    input.value = commandHistory[historyIndex] ?? "";
    event.preventDefault();
  } else if (event.key === "Tab") {
    event.preventDefault();
    const options = game.complete(input.value);
    if (options.length === 1) {
      input.value = input.value.replace(/\S*$/, options[0]) + " ";
    } else if (options.length > 1) {
      const prefix = options.reduce((acc, o) => {
        let i = 0;
        while (i < acc.length && acc[i] === o[i]) i++;
        return acc.slice(0, i);
      });
      const typed = /\S*$/.exec(input.value)?.[0] ?? "";
      if (prefix.length > typed.length) input.value = input.value.replace(/\S*$/, prefix);
      else print([{ kind: "sys", text: options.join("   ") }]);
    }
  } else if (event.key === "l" && event.ctrlKey) {
    event.preventDefault();
    output.innerHTML = "";
  }
});

document.querySelector(".terminal")?.addEventListener("click", () => {
  if (!window.getSelection()?.toString()) input.focus();
});

$("win-next").addEventListener("click", () => {
  winDialog.close();
  if (game.index === LEVELS.length - 1) showSummary();
  else start(game.index + 1);
});

$("win-replay").addEventListener("click", () => {
  winDialog.close();
  start(game.index);
});

setInterval(() => {
  renderMap();
  checkWin();
}, 500);

const fromHash = Number.parseInt(location.hash.slice(1), 10);
const firstUnsolved = LEVELS.findIndex((l) => !progress[l.id]);
start(fromHash >= 1 && fromHash <= LEVELS.length ? fromHash - 1 : Math.max(firstUnsolved, 0));
