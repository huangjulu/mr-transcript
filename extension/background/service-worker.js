// ============================================================
// YT Transcript - Service Worker
//
// Strategy: Use chrome.scripting.executeScript to run code
// INSIDE a YouTube tab (world: 'MAIN'). This way the InnerTube
// API call comes from youtube.com's own context — no bot
// detection, no cookie issues, no exp=xpe.
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_TRANSCRIPT') {
    handleFetchTranscript(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'LIST_LANGUAGES') {
    handleListLanguages(msg.videoId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// ---------- Tab management ----------

async function getOrCreateYouTubeTab(videoId) {
  // Look for an existing YouTube tab
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });

  if (tabs.length > 0) {
    // Navigate the first YouTube tab to the target video if needed
    const tab = tabs[0];
    if (!tab.url.includes(videoId)) {
      await chrome.tabs.update(tab.id, {
        url: `https://www.youtube.com/watch?v=${videoId}`,
      });
      // Wait for page to load
      await waitForTabLoad(tab.id);
    }
    return tab.id;
  }

  // Create a new tab (in background)
  const tab = await chrome.tabs.create({
    url: `https://www.youtube.com/watch?v=${videoId}`,
    active: false,
  });
  await waitForTabLoad(tab.id);
  return tab.id;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        setTimeout(resolve, 1500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---------- Execute in YouTube page context ----------

async function runInYouTubePage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args,
  });

  if (!results?.[0]) {
    throw new Error('Script execution failed');
  }

  const result = results[0].result;
  if (result?.error) {
    throw new Error(result.error);
  }
  return result;
}

// ---------- Functions that run inside YouTube page ----------

// This function runs INSIDE the YouTube page (world: MAIN)
function pageGetCaptionTracks(videoId) {
  try {
    // Try to get from ytInitialPlayerResponse (already in page)
    const playerResponse =
      window.ytInitialPlayerResponse ||
      window.ytplayer?.config?.args?.raw_player_response;

    if (playerResponse) {
      const renderer =
        playerResponse?.captions?.playerCaptionsTracklistRenderer;
      if (renderer?.captionTracks?.length) {
        return {
          tracks: renderer.captionTracks,
          translationLanguages: renderer.translationLanguages || [],
          title: playerResponse?.videoDetails?.title || null,
        };
      }
    }

    // Gather video details for smarter error messages
    const details = playerResponse?.videoDetails || {};
    const category = playerResponse?.microformat?.playerMicroformatRenderer?.category || '';
    const hasCaptionsField = !!playerResponse?.captions;

    // Fallback: try to call InnerTube API from within the page
    return {
      needsApi: true,
      videoMeta: {
        category,
        lengthSeconds: parseInt(details.lengthSeconds || '0', 10),
        publishDate: playerResponse?.microformat?.playerMicroformatRenderer?.publishDate || '',
        captionsDisabled: !hasCaptionsField,
      },
    };
  } catch (e) {
    return { error: e.message };
  }
}

// This function runs INSIDE the YouTube page to call InnerTube
async function pageCallInnerTube(videoId) {
  try {
    // Get API key from page config
    const apiKey =
      window.ytcfg?.get?.('INNERTUBE_API_KEY') ||
      window.yt?.config_?.INNERTUBE_API_KEY ||
      'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

    const res = await fetch(
      `/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38',
              androidSdkVersion: 33,
              hl: 'en',
              gl: 'US',
            },
          },
          videoId,
        }),
      }
    );

    const data = await res.json();
    const renderer = data?.captions?.playerCaptionsTracklistRenderer;
    if (!renderer?.captionTracks?.length) {
      return { error: 'No captions available for this video' };
    }

    return {
      tracks: renderer.captionTracks,
      translationLanguages: renderer.translationLanguages || [],
      title: data?.videoDetails?.title || null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// This function runs INSIDE the YouTube page to fetch the XML
async function pageFetchTranscript(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    return { xml: text };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- Smart error messages ----------

function getSmartError(meta) {
  if (!meta) return 'Oops, this video is speechless';

  if (meta.category === 'Music') {
    return 'It\'s a vibe, not a script 🎵';
  }

  if (meta.lengthSeconds > 0 && meta.lengthSeconds < 60) {
    return 'Too short, too fast, no subtitles';
  }

  if (meta.publishDate) {
    const hoursAgo = (Date.now() - new Date(meta.publishDate).getTime()) / 3600000;
    if (hoursAgo < 6) {
      return 'Fresh upload — captions need a moment ☕';
    }
  }

  if (meta.captionsDisabled) {
    return 'The creator said: no peeking 🙈';
  }

  return 'Oops, this video is speechless';
}

// ---------- Main handlers ----------

async function getCaptionData(videoId) {
  const tabId = await getOrCreateYouTubeTab(videoId);

  // Step 1: try to get tracks from page's existing data
  let result = await runInYouTubePage(tabId, pageGetCaptionTracks, [videoId]);

  const videoMeta = result.videoMeta || null;

  if (result.needsApi) {
    // Step 2: call InnerTube from within the page
    result = await runInYouTubePage(tabId, pageCallInnerTube, [videoId]);
  }

  if (!result.tracks?.length) {
    throw new Error(getSmartError(videoMeta));
  }

  // Check if URLs have exp=xpe
  const hasXpe = result.tracks.some((t) => t.baseUrl.includes('exp=xpe'));
  if (hasXpe) {
    console.log('[YT Transcript] URLs have exp=xpe, calling InnerTube from page...');
    const apiResult = await runInYouTubePage(tabId, pageCallInnerTube, [videoId]);
    if (apiResult.tracks?.length) {
      result = apiResult;
    }
  }

  return { ...result, tabId, title: result.title || null };
}

async function handleListLanguages(videoId) {
  const { tracks, translationLanguages } = await getCaptionData(videoId);

  const languages = tracks.map((t) => ({
    code: t.languageCode,
    label: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
    isAutoGenerated: t.kind === 'asr',
  }));

  for (const tl of (translationLanguages || [])) {
    const code = tl.languageCode;
    if (!languages.find((l) => l.code === code)) {
      const label =
        tl.languageName?.simpleText ||
        tl.languageName?.runs?.[0]?.text ||
        code;
      languages.push({ code, label, isTranslation: true });
    }
  }

  return { languages };
}

async function handleFetchTranscript({ videoId, lang, format, timestamps }) {
  const { tracks, translationLanguages, tabId, title } = await getCaptionData(videoId);

  let sourceTrack;
  let translationLang = null;

  if (lang) {
    sourceTrack = tracks.find((t) => t.languageCode === lang);
  }

  if (!sourceTrack && lang) {
    const isTranslatable = (translationLanguages || []).some(
      (tl) => tl.languageCode === lang
    );
    if (isTranslatable) {
      sourceTrack = tracks.find((t) => t.isTranslatable) || tracks[0];
      translationLang = lang;
    }
  }

  if (!sourceTrack) {
    sourceTrack = tracks.find((t) => t.kind !== 'asr') || tracks[0];
  }

  let url = sourceTrack.baseUrl.replace(/&fmt=srv3/g, '');
  if (translationLang) {
    url += `&tlang=${translationLang}`;
  }

  console.log('[YT Transcript] Fetching from page context:', url.substring(0, 120));

  // Fetch the XML from within the YouTube page context
  const xmlResult = await runInYouTubePage(tabId, pageFetchTranscript, [url]);

  if (xmlResult.error) {
    throw new Error(xmlResult.error);
  }

  console.log('[YT Transcript] XML length:', xmlResult.xml.length);

  const segments = parseTimedText(xmlResult.xml);
  if (!segments.length) {
    throw new Error('Transcript is empty — could not parse captions');
  }

  const langCode = translationLang || sourceTrack.languageCode || 'unknown';
  const safeName = title
    ? title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim()
    : videoId;
  let output, filename;

  if (format === 'srt') {
    output = toSRT(segments);
    filename = `${safeName}_${langCode}.srt`;
  } else {
    output = toTXT(segments, timestamps);
    filename = `${safeName}_${langCode}.txt`;
  }

  return { transcript: output, filename };
}

// ---------- XML parsing ----------

function parseTimedText(xml) {
  const segments = [];
  let m;

  const tPattern =
    /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = tPattern.exec(xml)) !== null) {
    const startMs = Math.round(parseFloat(m[1]) * 1000);
    const durMs = Math.round(parseFloat(m[2]) * 1000);
    const text = decodeXml(m[3]).trim();
    if (!text) continue;
    segments.push({ startMs, durMs, text });
  }

  if (!segments.length) {
    const pPattern = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = pPattern.exec(xml)) !== null) {
      const startMs = parseInt(m[1], 10);
      const durMs = parseInt(m[2], 10);
      const text = decodeXml(m[3]).trim();
      if (!text) continue;
      segments.push({ startMs, durMs, text });
    }
  }

  return segments;
}

function decodeXml(str) {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n/g, ' ');
}

// ---------- Formatters ----------

const FOOTER = '\n\n---\nTranscribed by YT Transcript | yokuru.com';

function toTXT(segments, timestamps) {
  const body = segments
    .map((s) => {
      if (timestamps) {
        return `[${msToTimestamp(s.startMs)}] ${s.text}`;
      }
      return s.text;
    })
    .join('\n');
  return body + FOOTER;
}

function toSRT(segments) {
  return segments
    .map((s, i) => {
      const start = msToSRTTime(s.startMs);
      const end = msToSRTTime(s.startMs + s.durMs);
      return `${i + 1}\n${start} --> ${end}\n${s.text}\n`;
    })
    .join('\n');
}

function msToTimestamp(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function msToSRTTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mil = ms % 1000;
  return (
    `${h.toString().padStart(2, '0')}:` +
    `${m.toString().padStart(2, '0')}:` +
    `${s.toString().padStart(2, '0')},` +
    `${mil.toString().padStart(3, '0')}`
  );
}
