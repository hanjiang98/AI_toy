/* Email parser: turns a pasted editorial-system email into structured fields.
 * Runs entirely in the browser; nothing is sent anywhere.
 * Targets ScholarOne / Research Exchange (IEEE), Editorial Manager (Elsevier)
 * and Springer Nature's systems, with generic fallbacks for everything else. */
(function (root) {
  'use strict';

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';

  function iso(y, m, d) {
    if (!(y > 1990 && y < 2100) || m == null) return null;
    const dt = new Date(Date.UTC(y, m, d));
    if (dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  }

  const DATE_PATTERNS = [
    // 05-Sep-2026, 5 September 2026
    { re: new RegExp('\\b(\\d{1,2})[-\\s]' + MON + '[-\\s,]+(\\d{4})\\b', 'gi'), f: m => iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]) },
    // Sep 5, 2026 / September 5th 2026
    { re: new RegExp('\\b' + MON + '\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b', 'gi'), f: m => iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]) },
    // 2026-09-05, 2026/9/5
    { re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, f: m => iso(+m[1], +m[2] - 1, +m[3]) },
    // 2026年9月5日
    { re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, f: m => iso(+m[1], +m[2] - 1, +m[3]) },
  ];

  function findDates(text) {
    const out = [];
    for (const p of DATE_PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text))) {
        const v = p.f(m);
        if (v) out.push({ iso: v, index: m.index });
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }

  const DEADLINE_CUE = /(?:by|before|until|no later than|due(?: date)?(?: is|:)?|deadline(?: is|:)?|on or before)\s*(?:on\s*)?[:\s]*$/i;

  function addDays(isoDate, n) {
    const d = new Date(isoDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function extractDate(text) {
    const header = text.match(/^\s*(?:date|sent|received|发送时间|日期|时间)\s*[:：]\s*(.+)$/im);
    if (header) {
      const d = findDates(header[1]);
      if (d.length) return d[0].iso;
    }
    for (const d of findDates(text)) {
      const before = text.slice(Math.max(0, d.index - 30), d.index);
      if (!DEADLINE_CUE.test(before)) return d.iso;
    }
    return null;
  }

  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, thirty: 30, sixty: 60, ninety: 90 };

  function extractDue(text, baseDate) {
    for (const d of findDates(text)) {
      const before = text.slice(Math.max(0, d.index - 30), d.index);
      if (DEADLINE_CUE.test(before)) return d.iso;
    }
    const m = text.match(/within\s+(?:the\s+next\s+)?(\d{1,3}|[a-z]+)\s*(?:\(\d+\)\s*)?(calendar\s+)?(days?|weeks?|months?)/i);
    if (m && baseDate) {
      const n = /^\d+$/.test(m[1]) ? +m[1] : NUM_WORDS[m[1].toLowerCase()];
      if (n) {
        const unit = m[3].toLowerCase();
        return addDays(baseDate, unit.startsWith('week') ? n * 7 : unit.startsWith('month') ? Math.round(n * 30.44) : n);
      }
    }
    return null;
  }

  /* ---------- manuscript ID ---------- */

  // IEEE: TSTE-04321-2026(.R1)  Elsevier: APEN-D-26-01234(R1)  Nature: NENERGY-26-01234(A), NCOMMS-26-12345-T
  const ID_RE = /\b[A-Z][A-Z0-9]{1,14}(?:[-_][A-Z0-9]{1,10}){1,5}(?:\.R\d{1,2})?\b/g;
  const ID_CUE = /(?:manuscript|submission|ms\.?|paper|ref(?:erence)?\.?|number|no\.|\bID\b|编号|稿件)[^\n]{0,25}$/i;

  function extractId(text) {
    let best = null;
    ID_RE.lastIndex = 0;
    let m;
    while ((m = ID_RE.exec(text))) {
      const tok = m[0];
      if ((tok.match(/\d/g) || []).length < 4) continue;
      const prev = text[m.index - 1] || ' ';
      const next = text[m.index + tok.length] || ' ';
      if (/[/@.\w]/.test(prev) || /[@/]/.test(next)) continue; // part of a URL or address
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      const score = ID_CUE.test(before) ? 2 : 1;
      if (!best || score > best.score) best = { id: tok, score };
    }
    return best ? best.id : null;
  }

  function splitId(id) {
    if (!id) return { base: '', round: 0 };
    let m;
    if ((m = id.match(/^(.*\d)\.R(\d{1,2})$/))) return { base: m[1], round: +m[2] };   // IEEE
    if ((m = id.match(/^(.*\d)R(\d{1,2})$/))) return { base: m[1], round: +m[2] };     // Elsevier
    if ((m = id.match(/^(.*\d)-?([A-H])$/))) return { base: m[1], round: m[2].charCodeAt(0) - 64 }; // Nature A, B, ...
    return { base: id, round: 0 };
  }

  /* ---------- title ---------- */

  function cleanTitle(s) {
    return s.replace(/\s+/g, ' ').replace(/^[\s"“'‘]+|[\s"”'’,.]+$/g, '').trim();
  }

  function extractTitle(text) {
    const patterns = [
      /(?:entitled|titled|title)\s*[:：,]?\s*["“「『]([\s\S]{5,500}?)["”」』]/i,
      /(?:manuscript|submission|paper|article)\s*,?\s*["“「『]([\s\S]{5,500}?)["”」』]/i,
      /(?:entitled|titled)\s*[:：,]?\s*['‘]([\s\S]{5,500}?)['’](?=[\s,.;:)])/i,
      /^\s*(?:manuscript |article |paper )?title\s*[:：]\s*(.{5,500})$/im,
      /^\s*(?:subject:\s*)?submission confirmation for\s+(.{5,500})$/im,
      /题目\s*[:：为]?\s*[《"“]?([^》"”\n]{5,300})/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const t = cleanTitle(m[1]);
        if (t.length >= 5 && !/^https?:/i.test(t)) return t;
      }
    }
    return null;
  }

  /* ---------- journal & publisher ---------- */

  const GENERIC_SENDER = /^(?:no-?reply|do-?not-?reply|editorial manager|elsevier(?: editorial system)?|em|scholarone(?: manuscripts)?|manuscript ?central|onbehalfof|ieee|springer ?nature|nature portfolio|editorial office|journal|research exchange|submissions?|support)$/i;

  function cleanJournal(s) {
    if (!s) return null;
    s = s.replace(/\s+/g, ' ')
      .replace(/^(?:the)\s+/i, '')
      .replace(/\s*(?:editorial office|editorial manager|editorial team|editor(?:s|ial)?|office)\s*$/i, '')
      .replace(/[\s,.:;\-–]+$/, '')
      .trim();
    if (s.length < 3 || s.length > 120 || GENERIC_SENDER.test(s)) return null;
    if (/@|https?:/i.test(s)) return null;
    return s;
  }

  function extractJournal(text) {
    const tries = [];
    // Display name of the sender: "IEEE Transactions on X <onbehalfof@...>"
    for (const line of text.split(/\r?\n/).slice(0, 15)) {
      const m = line.match(/^\s*(?:from:\s*)?"?([^"<\n]{3,120}?)"?\s*<[^>\s]+@[^>\s]+>/i);
      if (m) tries.push(m[1]);
    }
    const ieee = text.match(/\b(IEEE\s+(?:Transactions|Journal|Open Journal|Access|Letters|Systems Journal)\b[^\n.,;<>()\-–]{0,90})/);
    if (ieee) tries.push(ieee[1]);
    const pub = text.match(/(?:publication|consideration|publish(?:ing)?)\s+in\s+(?:the\s+)?([A-Z][^.\n,;]{2,100}?)(?:\.\s|\.$|\n|,|;| and | as )/m);
    if (pub) tries.push(pub[1]);
    const to = text.match(/(?:submitting|submitted|submission|thank you for)[^.]{0,300}?\bto\s+(?:the\s+)?([A-Z][A-Za-z&:\- ]{2,100}?)(?:\.|\n|,|!|;| and | for | -)/);
    if (to) tries.push(to[1]);
    const subj = text.match(/^(?:subject:\s*)?(.{3,120}?)\s+[-–]\s+(?:Manuscript|Decision|Submission|Ms\.?)\b/im);
    if (subj) tries.push(subj[1]);
    const nature = text.match(/\b(Nature(?:\s+(?!Portfolio|Research|Publishing)[A-Z][a-z]+){1,3}|Scientific Reports|Communications\s+(?:Earth|Engineering|Physics|Chemistry|Biology|Materials|Medicine)(?:\s+&\s+Environment)?)\b/);
    if (nature) tries.push(nature[1]);
    for (const c of tries) {
      const j = cleanJournal(c);
      if (j) return j;
    }
    return null;
  }

  function detectPublisher(text, journal) {
    const s = text + '\n' + (journal || '');
    if (/\bIEEE\b|manuscriptcentral|scholarone|researchexchange/i.test(s)) return 'IEEE';
    if (/elsevier|editorialmanager|sciencedirect|cell press|evise/i.test(s)) return 'Elsevier';
    if (/nature\.com|springernature|springer nature|nature portfolio|\bNature\s+[A-Z]|Scientific Reports/.test(s)) return 'Nature';
    return 'Other';
  }

  function extractPortal(text) {
    const urls = text.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
    const hit = urls.find(u => /manuscriptcentral|researchexchange|editorialmanager|mts-|nature\.com|springernature|elsevier/i.test(u));
    return hit ? hit.replace(/[.,;:]+$/, '') : null;
  }

  /* ---------- event type ---------- */

  // Order matters: earlier rules win.
  const RULES = [
    ['minor_revision', /conditional(?:ly)? accept|accept(?:ed)? (?:subject to|with (?:mandatory |minor )?(?:changes|revisions?|modifications))/],
    ['accepted', /accepted for publication|pleased to accept|(?:has|have) been accepted|is accepted|final acceptance|accept(?:ed)? (?:it )?in (?:its )?(?:current|present) form|decision (?:is|of|:)\s*["']?accept\b/],
    ['published', /(?:now|been) published online|has been published|is now available online/],
    ['proofs', /proofs? (?:of|for) your (?:article|paper|manuscript)|galley proofs?|correct(?:ed|ing)? (?:your )?proofs/],
    ['withdrawn', /has been withdrawn|withdrawal of your|withdrawn (?:at|per) your request/],
    ['transferred', /has been (?:successfully )?transferred|transfer (?:has been|was) (?:completed|received)/],
    ['reject_resubmit', /reject(?:ed)?\s*(?:and|&|\/)\s*resubmit|revise and resubmit as a new|resubmit (?:it )?as a new (?:manuscript|submission|paper)|encourage you to resubmit/],
    ['rejected', /regret to (?:inform|tell|say|advise)|(?:we )?regret that|unable to (?:offer (?:to )?)?(?:accept|publish|consider)|unable to offer publication|not (?:be )?(?:suitable|accepted|acceptable) for publication|decided (?:not to (?:publish|accept|send|consider)|to reject|against publication)|decision (?:is|of|:)\s*["']?reject|cannot (?:accept|be considered|consider|publish|offer)|decline (?:to publish|publication|your)|will not be (?:able to )?(?:consider|publish|pursu)|(?:been|is) rejected|not to pursue/],
    ['major_revision', /major revision|major modifications|substantial revision/],
    ['minor_revision', /minor revision|minor modifications/],
    ['revise', /invite you to (?:revise|submit a revised|resubmit)|revise (?:your|the) (?:manuscript|paper|submission)|revisions? (?:is|are) (?:required|necessary|needed|requested)|requires? (?:a )?revision|submit a revised (?:version|manuscript)|address the (?:reviewers|referees)/],
    ['reviews_complete', /required reviews (?:are |have been )?complete|reviews? (?:have|has) been completed|all reviews (?:have been )?(?:received|returned|completed)|decision in process/],
    ['under_review', /(?:is )?now under (?:peer )?review|(?:has been|was) sent (?:out )?(?:for|to) (?:external |peer )?(?:review|reviewers|referees)|status[^.\n]{0,40}(?:changed )?to ["']?under review|reviewers have been (?:invited|assigned)|out for review/],
    ['with_editor', /has been assigned to (?:an? |the )?(?:associate |handling |academic )?editor|editor (?:has been )?assigned|status[^.\n]{0,40}(?:changed )?to ["']?with editor/],
    ['submitted', /successfully submitted|thank you for (?:your )?submi(?:tting|ssion)|we have (?:now )?received your|has been received|submission confirmation|acknowledge (?:the )?receipt|has been submitted|confirm(?:ing)? (?:the )?(?:receipt|submission)|投稿成功|已收到/],
  ];

  const REVISION_TYPES = new Set(['major_revision', 'minor_revision', 'revise', 'reject_resubmit']);

  function classify(text, round) {
    const s = text.toLowerCase().replace(/\s+/g, ' ');
    for (const [type, re] of RULES) {
      if (re.test(s)) {
        if (type === 'submitted' && (round > 0 || /revised (?:manuscript|version|paper|submission)|your revision|resubmi/.test(s))) return 'revision_submitted';
        return type;
      }
    }
    return 'other';
  }

  function stripBanners(text) {
    return text.replace(/^\s*\[External Email\][^\n]*$/gim, '').replace(/^\s*(?:CAUTION|WARNING):[^\n]*external[^\n]*$/gim, '');
  }

  function parseEmail(raw, today) {
    const text = stripBanners(String(raw || ''));
    const title = extractTitle(text);
    // Remove the title before keyword analysis so words inside it ("Reject", "Accept") don't mislead.
    const body = title ? text.split(title).join(' ').replace(/[“”"]\s*[“”"]/g, ' ') : text;
    const msId = extractId(text);
    const { base, round } = splitId(msId);
    const journal = extractJournal(body);
    const date = extractDate(text) || today || new Date().toISOString().slice(0, 10);
    const type = classify(body, round);
    const addr = text.match(/\bDear\s+([^,:\n]{2,60}?)\s*[,:：\n]/);
    return {
      type,
      date,
      msId: msId || '',
      baseId: base,
      round,
      title: title || '',
      journal: journal || '',
      publisher: detectPublisher(text, journal),
      addressee: addr ? addr[1].trim() : '',
      portal: extractPortal(text) || '',
      due: REVISION_TYPES.has(type) ? extractDue(body, date) || '' : '',
    };
  }

  const api = { parseEmail, splitId, classify, extractDate, extractDue, extractId, extractTitle, extractJournal, REVISION_TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MSParser = api;
})(typeof window !== 'undefined' ? window : this);
