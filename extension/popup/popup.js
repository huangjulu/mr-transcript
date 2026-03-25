// ============================================================
// YT Transcript - Popup (Grass UI)
//
// Flow: paste URL → pick language → download transcript
// ============================================================

const $ = (sel) => document.querySelector(sel);

const elInputUrl      = $('#input-url');
const elSelLang       = $('#sel-language');
const elBtnDownload   = $('#btn-download');
const elOptionsArea   = $('#options-area');
const elDropdown      = $('#dropdown');
const elDropTrigger   = $('#dropdown-trigger');
const elDropLabel     = $('#dropdown-label');
const elDropMenu      = $('#dropdown-menu');
const elStatusArea  = $('#status-area');
const elStatusDot   = $('#status-dot');
const elStatusText  = $('#status-text');
const elErrorArea   = $('#error-area');
const elErrorText   = $('#error-text');
const elToast       = $('#toast-popover');

// ---------- Init ----------

document.addEventListener('DOMContentLoaded', () => {
  elBtnDownload.addEventListener('click', handleDownload);

  // Start disabled
  setControlsEnabled(false);

  // Auto-detect URL from current tab first, then fallback to saved URL
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.url && isYouTubeUrl(tab.url)) {
      const vid = extractVideoId(tab.url);
      if (vid) {
        const display = `youtube.com/watch?v=${vid}`;
        elInputUrl.value = display;
        lastVideoId = vid;
        chrome.storage.local.set({ savedUrl: display });
        setControlsEnabled(true);
        loadLanguages(vid);
        elInputUrl.focus();
        elInputUrl.select();
        return;
      }
    }

    // Not on YouTube — restore saved URL
    chrome.storage.local.get('savedUrl', ({ savedUrl }) => {
      if (savedUrl) {
        elInputUrl.value = savedUrl;
        const vid = extractVideoId(savedUrl);
        if (vid) {
          lastVideoId = vid;
          setControlsEnabled(true);
          loadLanguages(vid);
        }
      }
      elInputUrl.focus();
      elInputUrl.select();
    });
  });

  // Update button label when format changes
  document.querySelectorAll('input[name="format"]').forEach((el) => {
    el.addEventListener('change', updateBtnLabel);
  });

  // Select all on focus
  elInputUrl.addEventListener('focus', () => elInputUrl.select());

  // Load languages when URL changes or is pasted
  elInputUrl.addEventListener('change', onUrlChange);
  elInputUrl.addEventListener('paste', () => setTimeout(onUrlChange, 50));
  elInputUrl.addEventListener('input', onUrlChange);

  // Custom dropdown toggle
  elDropTrigger.addEventListener('click', () => {
    elDropMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!elDropdown.contains(e.target)) {
      elDropMenu.classList.add('hidden');
    }
  });
});

let lastVideoId = null;

function onUrlChange() {
  const raw = elInputUrl.value.trim();
  const vid = extractVideoId(raw);
  const hasInput = raw.length > 0;

  if (vid) {
    hideError();
    setControlsEnabled(true);
    if (vid !== lastVideoId) {
      lastVideoId = vid;
      const display = `youtube.com/watch?v=${vid}`;
      elInputUrl.value = display;
      chrome.storage.local.set({ savedUrl: display });
      loadLanguages(vid);
    }
  } else if (hasInput && !vid) {
    // Input has content but not a valid YouTube URL — keep button enabled
    hideError();
    setControlsEnabled(true);
  } else if (!hasInput) {
    lastVideoId = null;
    chrome.storage.local.remove('savedUrl');
    setControlsEnabled(false);
  }
}

function setControlsEnabled(enabled) {
  if (enabled) {
    elOptionsArea.classList.remove('hidden');
    elBtnDownload.disabled = false;
    elBtnDownload.style.pointerEvents = '';
    elBtnDownload.className = 'grass-btn-primary w-full mt-4 text-xs';
    updateBtnLabel();
  } else {
    elOptionsArea.classList.add('hidden');
    elBtnDownload.disabled = true;
    elBtnDownload.textContent = 'DOWNLOAD';
    elBtnDownload.className = 'w-full mt-4 text-xs inline-flex items-center justify-center rounded-full px-5 py-2 font-bold tracking-wider cursor-default bg-[#E5E7EB] text-[#6B7280]';
    elBtnDownload.style.pointerEvents = 'none';
  }
}

function updateBtnLabel() {
  const format = document.querySelector('input[name="format"]:checked')?.value || 'txt';
  elBtnDownload.textContent = `DOWNLOAD ${format.toUpperCase()}`;
}

// ---------- Core ----------

async function handleDownload() {
  const url = elInputUrl.value.trim();
  const videoId = extractVideoId(url);

  if (!videoId) {
    showError('Invalid YouTube URL');
    return;
  }

  hideError();
  showStatus('Fetching transcript...');
  elBtnDownload.disabled = true;

  try {
    const lang = elSelLang.value === 'auto' ? undefined : elSelLang.value;
    const format = document.querySelector('input[name="format"]:checked').value;
    const timestamps = $('#chk-timestamps').checked;

    chrome.runtime.sendMessage(
      { type: 'FETCH_TRANSCRIPT', videoId, lang, format, timestamps },
      (res) => {
        elBtnDownload.disabled = false;

        if (chrome.runtime.lastError || res?.error) {
          showError(res?.error || 'Failed to fetch transcript');
          hideStatus();
          return;
        }

        if (res?.transcript) {
          downloadFile(res.transcript, res.filename || `${videoId}.${format}`);
          hideStatus();
          toast('Downloaded!');
        }
      }
    );
  } catch (err) {
    elBtnDownload.disabled = false;
    showError(err.message);
    hideStatus();
  }
}

// Maps language code → ISO 3166-1 alpha-2 country code for flag-icons
const LANG_TO_COUNTRY = {
  en: 'us', 'en-US': 'us', 'en-GB': 'gb',
  'zh-TW': 'tw', 'zh-Hant': 'tw', 'zh-CN': 'cn', 'zh-Hans': 'cn', zh: 'cn',
  ja: 'jp', ko: 'kr', es: 'es', 'es-419': 'es', 'es-ES': 'es', 'es-MX': 'mx', 'es-US': 'es',
  fr: 'fr', 'fr-FR': 'fr', 'fr-CA': 'ca', de: 'de', 'de-DE': 'de', 'de-AT': 'at', 'de-CH': 'ch',
  pt: 'br', 'pt-BR': 'br', 'pt-PT': 'pt',
  ru: 'ru', ar: 'sa', hi: 'in', th: 'th', vi: 'vn', id: 'id', ms: 'my',
  it: 'it', nl: 'nl', pl: 'pl', tr: 'tr', uk: 'ua', sv: 'se', da: 'dk',
  fi: 'fi', no: 'no', el: 'gr', he: 'il', cs: 'cz', ro: 'ro', hu: 'hu',
  bg: 'bg', hr: 'hr', sk: 'sk', fil: 'ph', bn: 'bd', ta: 'in', te: 'in',
  af: 'za', ca: 'es', eu: 'es', gl: 'es', sr: 'rs', sl: 'si', lt: 'lt',
  lv: 'lv', et: 'ee', sw: 'ke', ne: 'np', ur: 'pk', fa: 'ir', ml: 'in',
};

function getFlagHtml(code) {
  const country = LANG_TO_COUNTRY[code];
  if (country) {
    return `<span class="fi fi-${country}" style="font-size:14px;border-radius:2px;box-shadow:1px 2px 0 #191A23;border:1px solid #191A23"></span>`;
  }
  return '<span style="font-size:14px;width:18px;display:inline-block;text-align:center;">🌐</span>';
}

function loadLanguages(videoId) {
  elDropLabel.textContent = 'Loading...';
  elDropTrigger.disabled = true;

  chrome.runtime.sendMessage({ type: 'LIST_LANGUAGES', videoId }, (res) => {
    elDropTrigger.disabled = false;

    if (chrome.runtime.lastError || res?.error) {
      setDropdownValue('auto', `${getFlagHtml('')} <span>Auto-detect</span>`);
      elDropMenu.innerHTML = renderDropdownItem('auto', getFlagHtml(''), 'Auto-detect', '');
      return;
    }

    const items = [renderDropdownItem('auto', getFlagHtml(''), 'Auto-detect', '')];
    for (const lang of res.languages) {
      const flag = getFlagHtml(lang.code);
      const tag = lang.isAutoGenerated ? 'auto' : lang.isTranslation ? 'translate' : '';
      items.push(renderDropdownItem(lang.code, flag, lang.label, tag));
    }
    elDropMenu.innerHTML = items.join('');

    // Bind click events
    elDropMenu.querySelectorAll('[data-value]').forEach((el) => {
      el.addEventListener('click', () => {
        const val = el.dataset.value;
        const text = el.dataset.text;
        const flagHtml = getFlagHtml(val);
        setDropdownValue(val, `${flagHtml} <span>${text}</span>`);
        chrome.storage.local.set({ savedLang: val, savedLangLabel: text });
        elDropMenu.classList.add('hidden');
      });
    });

    // Restore saved language if available in this video's options
    chrome.storage.local.get(['savedLang', 'savedLangLabel'], ({ savedLang, savedLangLabel }) => {
      if (savedLang && savedLangLabel) {
        const exists = res.languages.some((l) => l.code === savedLang) || savedLang === 'auto';
        if (exists) {
          const flagHtml = getFlagHtml(savedLang);
          setDropdownValue(savedLang, `${flagHtml} <span>${savedLangLabel}</span>`);
          return;
        }
      }
      setDropdownValue('auto', `${getFlagHtml('')} <span>Auto-detect</span>`);
    });
  });
}

function renderDropdownItem(value, flagHtml, label, tag) {
  const tagHtml = tag === 'auto'
    ? '<span class="ml-auto text-[9px] font-bold uppercase bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded-full">auto</span>'
    : tag === 'translate'
    ? '<span class="ml-auto text-[9px] font-bold uppercase bg-[#FFF8E0] text-[#9a7800] px-1.5 py-0.5 rounded-full">translate</span>'
    : '';
  return `<div data-value="${value}" data-flag="${value}" data-text="${label}" class="flex items-center gap-2 px-3 py-2 text-sm font-semibold cursor-pointer hover:bg-[#FFF8E0] transition-colors" style="color:#495057">${flagHtml}<span class="truncate">${label}</span>${tagHtml}</div>`;
}

function setDropdownValue(value, label) {
  elSelLang.value = value;
  elDropLabel.innerHTML = label;
}

// ---------- Helpers ----------

function isYouTubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

function extractVideoId(url) {
  if (!url) return null;
  // Add https:// if user typed without protocol
  const normalized = url.trim().match(/^https?:\/\//) ? url.trim() : `https://${url.trim()}`;
  const m = normalized.match(/(?:youtu\.be\/|[?&]v=)([\w-]{11})/);
  return m ? m[1] : null;
}

function downloadFile(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- UI States ----------

function showStatus(text) {
  elStatusText.textContent = text;
  elStatusArea.classList.remove('hidden');
}

function hideStatus() {
  elStatusArea.classList.add('hidden');
}

function showError(text) {
  toast(text, true);
  hideStatus();
}

function hideError() {
  elErrorArea.classList.add('hidden');
}

function toast(text, isError) {
  elToast.textContent = text;
  elToast.className = `fixed top-3 left-1/2 -translate-x-1/2 z-50 text-xs font-bold px-4 py-2 rounded-full tracking-wide shadow-hard ${
    isError ? 'bg-red-500 text-white' : 'bg-black text-lime'
  }`;
  setTimeout(() => elToast.classList.add('hidden'), 2500);
}
