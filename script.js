const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const KEY = 'recall-deck-v1';
const SOUND_KEY = 'recall-sound-v1';
let deck = JSON.parse(localStorage.getItem(KEY) || '[]');
let queue = [], cur = null, total = 0, done = 0;
let audio = null, installPrompt = null, ocrWorker = null;
const OCR_ASSETS = new URL('./vendor/tesseract/', window.location.href).href;

const save = () => localStorage.setItem(KEY, JSON.stringify(deck));
const today = () => new Date().toISOString().slice(0, 10);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const soundEnabled = () => localStorage.getItem(SOUND_KEY) !== 'off';

function playNotes(notes) {
  if (!soundEnabled()) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  audio ||= new AudioContext();
  if (audio.state === 'suspended') audio.resume();
  const start = audio.currentTime;
  notes.forEach(([frequency, offset, duration]) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, start + offset);
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.055, start + offset + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + duration + 0.01);
  });
}

function updateSoundButton() {
  const enabled = soundEnabled();
  $('#sound').textContent = enabled ? '♫ Sound on' : '♫ Sound off';
  $('#sound').setAttribute('aria-pressed', String(enabled));
}

function updateConnectionStatus() {
  $('#appstatus').textContent = navigator.onLine
    ? 'Online · your cards are saved on this device'
    : 'Offline · your cards and study tools are ready';
}

window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('#install').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install').hidden = true;
  $('#appstatus').textContent = 'App installed · your cards are saved on this device';
});

$('#sound').onclick = () => {
  localStorage.setItem(SOUND_KEY, soundEnabled() ? 'off' : 'on');
  updateSoundButton();
  if (soundEnabled()) playNotes([[784, 0, .09]]);
};
$('#install').onclick = async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  $('#install').hidden = true;
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js')
    .then(() => { updateConnectionStatus(); })
    .catch(error => {
      console.error('Could not register the offline app cache.', error);
      $('#appstatus').textContent = 'Offline install is unavailable here; use a local web server or HTTPS.';
    });
}
updateConnectionStatus();
updateSoundButton();

/* ---------- Parser: "abd - Abdomen" -> {a, m} ---------- */
function parse(text) {
  const seen = new Set(), out = [];
  text.split(/\r?\n/).forEach(line => {
    line = line.replace(/^\s*(\d+[.)]|[•*·])\s*/, '');       // remove bullets/numbers
    const m = line.match(/^\s*(.+?)\s*[-–—:]\s*(.+?)\s*$/);   // split at first separator
    if (!m) return;
    const key = m[1].trim().toLowerCase();
    if (seen.has(key)) return;                                 // skip duplicates
    seen.add(key);
    out.push({ a: m[1].trim(), m: m[2].trim() });
  });
  return out;
}

/* ---------- Mastery logic ---------- */
// Mastered = 3 right in a row AND correct on 2+ different days
const status = c => c.streak >= 3 && c.days >= 2 ? 'mastered'
  : c.wrong > 0 && c.streak < 2 ? 'needs' : 'learning';
const rank = { needs: 0, learning: 1, mastered: 2 };

function grade(ok) {
  const c = cur;
  if (!c) return;
  if (ok) {
    c.right++; c.streak++;
    if (c.last !== today()) { c.days++; c.last = today(); }
  } else {
    c.wrong++; c.streak = 0; c.days = 0;
  }
  save(); burst(ok);
  playNotes(ok ? [[659, 0, .09], [988, .09, .12]] : [[330, 0, .13]]);
  queue.shift();
  if (ok) done++;
  else queue.splice(Math.min(3, queue.length), 0, c.id);       // wrong cards return in ~3 cards
  next();
}

/* ---------- Study session ---------- */
function start() {
  const focus = $('#mode').value === 'focus';
  let pool = [...deck];
  if (focus) {
    pool = pool.filter(c => status(c) !== 'mastered')
      .sort((x, y) => rank[status(x)] - rank[status(y)] || y.wrong - x.wrong).slice(0, 15);
  } else {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  queue = pool.map(c => c.id); total = queue.length; done = 0;
  next();
}

function next() {
  $('#card').classList.remove('flip');
  $('#pbar').style.width = (total ? done / total * 100 : 0) + '%';
  $('#count').textContent = total ? `${done} / ${total} done` : '';
  $('#verdict').textContent = ''; $('#ans').value = '';
  cur = deck.find(c => c.id === queue[0]);
  if (!cur) {
    $('#fa').textContent = deck.length ? 'All done!' : 'No cards';
    $('#fm').textContent = deck.length ? 'Tap Shuffle & start to go again' : 'Import notes first';
    $('#acts').hidden = true; $('#tf').hidden = true;
    return;
  }
  $('#fa').textContent = cur.a; $('#fm').textContent = cur.m;
  $('#acts').hidden = false; $('#tf').hidden = !$('#typed').checked;
}

$('#card').onclick = () => {
  if (!cur) return;
  $('#card').classList.toggle('flip');
  playNotes([[523, 0, .06]]);
};
$('#got').onclick = () => grade(true);
$('#again').onclick = () => grade(false);
$('#start').onclick = start;
$('#typed').onchange = () => { $('#tf').hidden = !cur || !$('#typed').checked; };
$('#tf').onsubmit = e => {
  e.preventDefault();
  if (!cur) return;
  const n = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ok = n($('#ans').value) === n(cur.m);
  $('#verdict').textContent = ok ? 'Correct! Press Got it.' : 'Not quite. Check the back, then press Review again.';
  $('#card').classList.add('flip');
  playNotes([[523, 0, .06]]);
};

/* ---------- Import ---------- */
function showPreview() {
  const p = parse($('#raw').value);
  $('#preview').innerHTML = p.length
    ? `<p class="hint">${p.length} cards found. Fix any mistakes above.</p>` +
      p.map(x => `<span class="chip"><b>${esc(x.a)}</b> ${esc(x.m)}</span>`).join('')
    : '<p class="hint">No "acronym - meaning" lines yet.</p>';
}
$('#raw').oninput = showPreview;
$('#sample').onclick = () => {
  $('#raw').value = 'abd - Abdomen\nROM - Range of Motion\nADL - Activities of Daily Living\nBP - Blood Pressure\nHR - Heart Rate';
  showPreview();
};

$('#file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  $('#ocr').textContent = 'Reading notes... 0%';
  try {
    if (!ocrWorker) {
      ocrWorker = await window.Tesseract.createWorker('eng', 1, {
        workerPath: `${OCR_ASSETS}worker.min.js`,
        corePath: `${OCR_ASSETS}core`,
        langPath: `${OCR_ASSETS}lang`,
        cachePath: 'recall-offline-ocr-v1',
        gzip: true,
        lstmOnly: true,
        logger: m => {
          if (m.status) $('#ocr').textContent = `${m.status}... ${Math.round((m.progress || 0) * 100)}%`;
        }
      });
    }
    const r = await ocrWorker.recognize(f);
    $('#raw').value = r.data.text.trim();
    $('#ocr').textContent = 'Done. OCR works offline now. Check for mistakes below.';
    showPreview();
  } catch (err) {
    console.error('Could not read the notes image.', err);
    $('#ocr').textContent = navigator.onLine
      ? 'Could not read the photo. Try a clearer photo or paste the text.'
      : 'Could not load offline OCR files. Reconnect once to install the app files, then try again.';
  }
  e.target.value = '';
};

$('#make').onclick = () => {
  const p = parse($('#raw').value);
  if (!p.length) return;
  p.forEach(x => {
    const old = deck.find(c => c.a.toLowerCase() === x.a.toLowerCase());
    if (old) old.m = x.m;
    else deck.push({ id: Math.random().toString(36).slice(2), a: x.a, m: x.m, right: 0, wrong: 0, streak: 0, days: 0, last: '' });
  });
  save(); $('#raw').value = ''; showPreview();
  tab('study'); start();
};

/* ---------- Deck ---------- */
function renderDeck() {
  const n = s => deck.filter(c => status(c) === s).length;
  $('#stats').innerHTML = ['needs', 'learning', 'mastered'].map(s => `<span class="tag ${s}">${s} ${n(s)}</span>`).join('');
  $('#list').innerHTML = [...deck]
    .sort((x, y) => rank[status(x)] - rank[status(y)] || y.wrong - x.wrong)
    .map(c => `<div class="row"><b>${esc(c.a)}</b><span>${esc(c.m)}</span><em class="tag ${status(c)}">${status(c)}</em></div>`)
    .join('') || '<p class="hint">Deck is empty.</p>';
}
$('#clear').onclick = () => {
  if (confirm('Delete all cards and progress?')) { deck = []; queue = []; save(); renderDeck(); }
};

/* ---------- Tabs ---------- */
function tab(t) {
  $$('main > section').forEach(s => s.hidden = s.id !== t);
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (t === 'deck') renderDeck();
  if (t === 'study' && !queue.length) start();
}
$$('nav button').forEach(b => b.onclick = () => tab(b.dataset.tab));

/* ---------- Pixel effects ---------- */
for (let i = 0; i < 18; i++) {
  const s = document.createElement('i');
  s.style.cssText = `left:${Math.random() * 100}%;--s:${6 + Math.floor(Math.random() * 3) * 4}px;` +
    `animation-duration:${8 + Math.random() * 8}s;animation-delay:${-Math.random() * 12}s`;
  $('#sky').appendChild(s);
}
function burst(ok) {
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('i');
    p.className = 'pop';
    p.style.cssText = `--x:${(Math.random() - .5) * 260}px;--y:${-60 - Math.random() * 140}px;background:${ok ? '#ff4fa3' : '#b39bff'}`;
    $('#stage').appendChild(p);
    setTimeout(() => p.remove(), 750);
  }
}

showPreview();