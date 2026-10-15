const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const KEY = 'recall-deck-v1';
const SOUND_KEY = 'recall-sound-v1';
let deck = JSON.parse(localStorage.getItem(KEY) || '[]');
let queue = [], cur = null, total = 0, done = 0;
let flippedThisCard = false;
let audio = null, installPrompt = null, ocrWorker = null;
const OCR_ASSETS = new URL('./vendor/tesseract/', window.location.href).href;
const MAX_OCR_IMAGE_BYTES = 7 * 1024 * 1024;

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
const statuses = ['needs', 'learning', 'mastered'];
const status = c => statuses.includes(c.masteryStatus) ? c.masteryStatus : 'learning';
const rank = { needs: 0, learning: 1, mastered: 2 };
const countStatus = value => deck.filter(c => status(c) === value).length;

function renderStatusSummary(lastCard = null) {
  const counts = `Needs: ${countStatus('needs')} · Learning: ${countStatus('learning')} · Mastered: ${countStatus('mastered')}`;
  const result = lastCard ? ` · Last result: ${status(lastCard).toUpperCase()} — ${lastCard.a}` : '';
  $('#status-summary').textContent = counts + result;
}

function grade(ok) {
  const c = cur;
  if (!c) return;
  c.masteryStatus = ok ? (flippedThisCard ? 'learning' : 'mastered') : 'needs';
  if (ok) {
    c.right++; c.streak++;
    if (c.last !== today()) { c.days++; c.last = today(); }
  } else {
    c.wrong++; c.streak = 0; c.days = 0;
  }
  save();
  renderStatusSummary(c);
  burst(ok);
  playNotes(ok ? [[659, 0, .09], [988, .09, .12]] : [[330, 0, .13]]);
  queue.shift();
  if (ok) {
    done++;
  } else {
    queue.splice(Math.min(3, queue.length), 0, c.id);       // wrong cards return in ~3 cards
  }
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
  flippedThisCard = false;
  $('#fa').textContent = cur.a; $('#fm').textContent = cur.m;
  $('#mastery-progress').textContent = `${status(cur)} · tap to flip`;
  $('#acts').hidden = false; $('#tf').hidden = !$('#typed').checked;
}

$('#card').onclick = () => {
  if (!cur) return;
  flippedThisCard = true;
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
  flippedThisCard = true;
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

async function prepareOcrImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const maxDimension = 2800;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('Could not prepare the photo for OCR.');
  }
  context.filter = 'grayscale(1) contrast(1.2)';
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const image = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (Math.ceil(image.length * 3 / 4) > MAX_OCR_IMAGE_BYTES) {
    throw new Error('The processed photo is still too large. Try a closer, lower-resolution photo.');
  }
  return { canvas, image };
}

async function recognizeLocally(image) {
  if (!ocrWorker) {
    ocrWorker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: `${OCR_ASSETS}worker.min.js`,
      corePath: `${OCR_ASSETS}core`,
      langPath: `${OCR_ASSETS}lang`,
      cachePath: 'recall-offline-ocr-v1',
      gzip: true,
      lstmOnly: true,
      logger: m => {
        if (m.status) $('#ocr').textContent = `Offline OCR: ${m.status}... ${Math.round((m.progress || 0) * 100)}%`;
      }
    });
  }
  const result = await ocrWorker.recognize(image);
  return result.data.text.trim();
}

$('#file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.type.startsWith('image/')) {
    $('#ocr').textContent = 'Choose an image file to read notes.';
    e.target.value = '';
    return;
  }
  $('#ocr').textContent = 'Preparing and enhancing photo...';
  try {
    const { canvas, image } = await prepareOcrImage(f);
    let text;
    let message;
    if (navigator.onLine) {
      try {
        $('#ocr').textContent = 'Reading enhanced photo with Google Cloud Vision...';
        const response = await fetch('./api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image })
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || `Handwriting OCR failed (HTTP ${response.status}).`);
        }
        const result = await response.json();
        if (typeof result.text !== 'string') throw new Error('Handwriting OCR returned an invalid response.');
        if (!result.text.trim()) throw new Error('No text was detected in the photo.');
        text = result.text.trim();
        message = 'Handwriting read by Google Cloud Vision. Check the text below.';
      } catch (error) {
        console.warn('Google Cloud Vision was unavailable; using local OCR.', error);
        $('#ocr').textContent = 'Cloud OCR unavailable; trying local OCR...';
        text = await recognizeLocally(canvas);
        message = `Used local OCR because Cloud Vision was unavailable (${error.message}). Handwriting accuracy may be limited; check the text below.`;
      }
    } else {
      text = await recognizeLocally(canvas);
      message = 'Read with local offline OCR. Handwriting accuracy may be limited; check the text below.';
    }
    $('#raw').value = text;
    $('#ocr').textContent = message;
    showPreview();
  } catch (err) {
    console.error('Could not recognize the notes image.', err);
    $('#ocr').textContent = `${err.message || 'Could not read the photo.'} Check that the app server and OCR setup are available, or paste the text instead.`;
  }
  e.target.value = '';
};

$('#make').onclick = () => {
  const p = parse($('#raw').value);
  if (!p.length) return;
  p.forEach(x => {
    const old = deck.find(c => c.a.toLowerCase() === x.a.toLowerCase());
    if (old) old.m = x.m;
    else deck.push({ id: Math.random().toString(36).slice(2), a: x.a, m: x.m, right: 0, wrong: 0, streak: 0, days: 0, last: '', masteryStatus: 'learning' });
  });
  save(); renderStatusSummary(); $('#raw').value = ''; showPreview();
  tab('study'); start();
};

/* ---------- Deck ---------- */
function renderDeck() {
  $('#stats').innerHTML = statuses.map(s => `<span class="tag ${s}">${s} ${countStatus(s)}</span>`).join('');
  $('#list').innerHTML = [...deck]
    .sort((x, y) => rank[status(x)] - rank[status(y)] || y.wrong - x.wrong)
    .map(c => {
      const mastery = status(c);
      return `<div class="row"><b>${esc(c.a)}</b><span>${esc(c.m)}</span><em class="tag ${mastery}">${mastery}</em></div>`;
    })
    .join('') || '<p class="hint">Deck is empty.</p>';
}
$('#clear').onclick = () => {
  if (confirm('Delete all cards and progress?')) {
    deck = []; queue = []; save(); renderDeck(); renderStatusSummary();
  }
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
renderStatusSummary();